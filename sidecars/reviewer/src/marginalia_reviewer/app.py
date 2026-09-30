from __future__ import annotations

import hmac
import json
import secrets
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Literal

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.base import BaseHTTPMiddleware

from .config import Settings
from .db import (
    MAX_SEARCH_BOOK_LENGTH,
    MAX_SEARCH_ISBN_LENGTH,
    MAX_SEARCH_LIMIT,
    MAX_SEARCH_OFFSET,
    MAX_SEARCH_QUERY_LENGTH,
    Workspace,
)
from .importer import BundleImporter, BundleValidationError, ImportLimits, MagicapImporter, is_magicap_filename
from .ocr import NdlocrLiteAdapter
from .publisher import (
    GitHubContentsClient,
    GitHubCredentials,
    GitHubError,
    PublishConflict,
    build_publication,
    github_book_path,
    publication_diff,
    publication_diff_summary,
    publication_digest,
)
from .schema import validate_contract
from .ui import INDEX_HTML

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]"}


class BrowserSecurityMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: FastAPI, csrf_token: str, desktop_shutdown_token: str | None = None) -> None:
        super().__init__(app)
        self.csrf_token = csrf_token
        self.desktop_shutdown_token = desktop_shutdown_token

    async def dispatch(self, request: Request, call_next):  # type: ignore[no-untyped-def]
        host = request.headers.get("host", "")
        hostname = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]", 1)[0] + "]"
        if hostname.casefold() not in LOOPBACK_HOSTS:
            return JSONResponse({"detail": "invalid Host header"}, status_code=400)
        # The Desktop-owned shutdown request has no browser session. Permit it
        # to reach its route only with the high-entropy per-launch secret; the
        # route repeats this validation and has no effect without a callback.
        is_desktop_shutdown = request.url.path == "/api/desktop/shutdown"
        supplied_shutdown_token = request.headers.get("x-maginalia-reviewer-shutdown-token")
        has_valid_desktop_shutdown_token = (
            is_desktop_shutdown
            and self.desktop_shutdown_token is not None
            and supplied_shutdown_token is not None
            and secrets.compare_digest(supplied_shutdown_token, self.desktop_shutdown_token)
        )
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            if not has_valid_desktop_shutdown_token:
                origin = request.headers.get("origin")
                if origin is not None and origin.rstrip("/").casefold() != f"http://{host}".casefold():
                    return JSONResponse({"detail": "cross-origin request rejected"}, status_code=403)
                cookie = request.cookies.get("marginalia_csrf", "")
                header = request.headers.get("x-csrf-token", "")
                if not hmac.compare_digest(cookie, self.csrf_token) or not hmac.compare_digest(header, self.csrf_token):
                    return JSONResponse({"detail": "CSRF token required"}, status_code=403)
        return await call_next(request)


class ReviewUpdate(BaseModel):
    quote: str = Field(min_length=1, max_length=5000)
    contextBefore: str = Field(default="", max_length=5000)
    contextAfter: str = Field(default="", max_length=5000)
    pageLabel: str = Field(min_length=1, max_length=200)
    chapterLabel: str = Field(default="", max_length=500)
    comment: str = Field(default="", max_length=10000)


class CredentialUpdate(BaseModel):
    account: str
    token: str


class OcrRegionUpdate(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    left: float = Field(ge=0, le=1)
    top: float = Field(ge=0, le=1)
    right: float = Field(ge=0, le=1)
    bottom: float = Field(ge=0, le=1)
    kind: Literal["LINE", "COLUMN", "ELEMENT"] = "LINE"
    text: str = Field(max_length=20000, default="")


class RegionSetUpdate(BaseModel):
    regions: list[OcrRegionUpdate] = Field(max_length=10000)


class OcrOrientationOverrideUpdate(BaseModel):
    orientation: Literal["AUTO", "VERTICAL", "HORIZONTAL"]


class PublishRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account: str
    owner: str
    repo: str
    branch: str = "main"
    expectedSha: str | None = None
    previewRevision: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")
    previewUpdatedAtMs: int = Field(ge=0)
    previewDigest: str = Field(pattern=r"^[0-9a-f]{64}$")


def create_app(
    settings: Settings | None = None,
    *,
    desktop_shutdown: Callable[[], None] | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.workspace.mkdir(parents=True, exist_ok=True)
    workspace = Workspace(settings.database_path)
    workspace.initialize()
    recovered = workspace.recover_interrupted()
    csrf_token = secrets.token_urlsafe(32)
    importer = BundleImporter(
        workspace,
        settings.imports_path,
        ImportLimits(
            settings.max_zip_bytes,
            settings.max_uncompressed_bytes,
            settings.max_entries,
            settings.max_entry_bytes,
            settings.max_compression_ratio,
        ),
    )
    magicap_importer = MagicapImporter(
        workspace,
        settings.imports_path,
        ImportLimits(
            settings.max_zip_bytes,
            settings.max_uncompressed_bytes,
            settings.max_entries,
            settings.max_entry_bytes,
            settings.max_compression_ratio,
        ),
    )
    ocr_lock = threading.Lock()
    app = FastAPI(title="Digital Marginalia Reviewer", docs_url=None, redoc_url=None)
    app.add_middleware(
        BrowserSecurityMiddleware,
        csrf_token=csrf_token,
        desktop_shutdown_token=settings.desktop_shutdown_token,
    )
    app.state.workspace = workspace
    app.state.recovered_pages = recovered
    app.state.ocr_lock = ocr_lock
    app.state.enable_legacy_github = settings.enable_legacy_github

    def require_legacy_github() -> None:
        if not settings.enable_legacy_github:
            raise HTTPException(404, "legacy GitHub publication is disabled")

    @app.get("/", response_class=HTMLResponse)
    def index() -> str:
        if settings.enable_legacy_github:
            return INDEX_HTML
        return INDEX_HTML.replace('<section id="publication"', '<section id="publication" hidden')

    @app.get("/api/health")
    def health() -> dict[str, object]:
        return {
            "status": "ok",
            "service": "maginalia-reviewer",
            "contractVersion": 1,
        }

    @app.post("/api/desktop/shutdown", status_code=202)
    def desktop_shutdown_endpoint(request: Request, background_tasks: BackgroundTasks) -> dict[str, str]:
        """Accept one authenticated Desktop-owned cooperative shutdown request."""
        token = settings.desktop_shutdown_token
        supplied = request.headers.get("X-Maginalia-Reviewer-Shutdown-Token")
        # No configured token/callback means no local control surface at all.
        if desktop_shutdown is None or token is None:
            raise HTTPException(404, "Desktop shutdown is unavailable")
        if supplied is None or not secrets.compare_digest(supplied, token):
            raise HTTPException(403, "Desktop shutdown token is invalid")
        # Background work runs after the response has been sent, allowing the
        # parent to observe the 202 acknowledgement before waiting for exit.
        background_tasks.add_task(desktop_shutdown)
        return {"status": "shutting-down"}

    @app.get("/api/session")
    def session() -> JSONResponse:
        response = JSONResponse({
            "service": "maginalia-reviewer",
            "contractVersion": 1,
            "csrfToken": csrf_token,
            "recoveredPages": recovered,
        })
        response.set_cookie(
            "marginalia_csrf", csrf_token, httponly=True, samesite="strict", secure=False, path="/"
        )
        return response

    @app.post("/api/import", status_code=201)
    async def import_bundle(bundle: UploadFile) -> dict[str, str]:
        settings.uploads_path.mkdir(parents=True, exist_ok=True)
        temporary = settings.uploads_path / f"{uuid.uuid4()}.zip"
        size = 0
        try:
            with temporary.open("xb") as output:
                while chunk := await bundle.read(1024 * 1024):
                    size += len(chunk)
                    if size > settings.max_zip_bytes:
                        raise HTTPException(413, "ZIP exceeds configured size limit")
                    output.write(chunk)
            source_name = Path(bundle.filename or "upload").name
            try:
                if is_magicap_filename(source_name):
                    import_id = magicap_importer.import_magicap(temporary, source_name)
                elif source_name.casefold().endswith(".zip"):
                    # Legacy Android export remains available, but a generic
                    # filename is never interpreted as the new contract.
                    import_id = importer.import_zip(temporary, source_name)
                else:
                    raise BundleValidationError("select a .magicap, .magicap.zip, or legacy .zip package")
            except (BundleValidationError, OSError, json.JSONDecodeError) as exc:
                raise HTTPException(400, str(exc)) from exc
            return {"importId": import_id}
        finally:
            await bundle.close()
            temporary.unlink(missing_ok=True)

    @app.get("/api/pages")
    def pages() -> list[dict[str, object]]:
        return workspace.list_pages()

    @app.get("/api/search")
    def search(
        q: str = Query(default="", max_length=MAX_SEARCH_QUERY_LENGTH),
        isbn: str | None = Query(default=None, max_length=MAX_SEARCH_ISBN_LENGTH),
        book: str | None = Query(default=None, max_length=MAX_SEARCH_BOOK_LENGTH),
        status: str = Query(default="APPROVED", max_length=32),
        limit: int = Query(default=50, ge=1, le=MAX_SEARCH_LIMIT),
        offset: int = Query(default=0, ge=0, le=MAX_SEARCH_OFFSET),
    ) -> dict[str, object]:
        try:
            results, total = workspace.search_quotes(
                query=q, isbn=isbn, book=book, status=status, limit=limit, offset=offset
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"results": results, "total": total, "limit": limit, "offset": offset}

    def page_or_404(page_id: str) -> dict[str, object]:
        page = workspace.get_page(page_id)
        if page is None:
            raise HTTPException(404, "page not found")
        return page

    @app.get("/api/pages/{page_id}")
    def page(page_id: str) -> dict[str, object]:
        result = page_or_404(page_id)
        result.pop("image_path", None)
        result["imageUrl"] = f"/api/pages/{page_id}/image"
        return result

    @app.get("/api/pages/{page_id}/image")
    def page_image(page_id: str) -> FileResponse:
        result = page_or_404(page_id)
        image = Path(str(result["image_path"]))
        if not image.is_file():
            raise HTTPException(404, "page image is unavailable")
        return FileResponse(image, media_type=str(result.get("image_media_type") or "image/jpeg"), filename=image.name)

    @app.post("/api/pages/{page_id}/ocr")
    def run_ocr(page_id: str) -> dict[str, str]:
        if settings.ndlocr_config is None:
            raise HTTPException(503, "MARGINALIA_NDLOCR_CONFIG is not configured")
        with ocr_lock:
            result = page_or_404(page_id)
            if not workspace.transition(page_id, {"PENDING", "FAILED", "NEEDS_REVIEW"}, "RUNNING"):
                raise HTTPException(409, "page is already running or approved")
            try:
                adapter = NdlocrLiteAdapter(settings.ndlocr_config, settings.ocr_timeout_seconds)
                regions, provenance = adapter.recognize(
                    Path(str(result["image_path"])), int(result["width"]), int(result["height"]), page_id
                )
                capture_ocr = {
                    str(annotation["id"]): adapter.recognize_selected_region(
                        Path(str(result["image_path"])),
                        int(result["width"]),
                        int(result["height"]),
                        page_id,
                        str(annotation["id"]),
                        annotation["selected_region"],
                    )
                    for annotation in result["annotations"]
                    if annotation.get("selected_region") is not None
                }
                workspace.save_ocr(page_id, regions, provenance, capture_ocr)
            except Exception as exc:
                workspace.fail_ocr(page_id, str(exc))
                raise HTTPException(502, str(exc)) from exc
        return {"status": "NEEDS_REVIEW"}

    @app.put("/api/pages/{page_id}/regions")
    def update_regions(page_id: str, update: RegionSetUpdate) -> dict[str, bool]:
        page_or_404(page_id)
        regions = [region.model_dump() for region in update.regions]
        identifiers = [region["id"] for region in regions]
        if len(identifiers) != len(set(identifiers)):
            raise HTTPException(422, "NDL OCR region IDs must be unique")
        if any(region["right"] <= region["left"] or region["bottom"] <= region["top"] for region in regions):
            raise HTTPException(422, "NDL OCR regions must have nondegenerate bounds")
        if not workspace.update_ocr_regions(page_id, regions):
            raise HTTPException(409, "page must finish OCR before region editing")
        return {"updated": True}

    @app.put("/api/pages/{page_id}/ocr-orientation")
    def update_ocr_orientation(page_id: str, update: OcrOrientationOverrideUpdate) -> dict[str, bool]:
        page_or_404(page_id)
        if not workspace.update_ocr_orientation_override(page_id, update.orientation):
            raise HTTPException(409, "page must finish OCR before changing orientation")
        return {"updated": True}

    @app.put("/api/annotations/{annotation_id}")
    def update_annotation(annotation_id: str, review: ReviewUpdate) -> dict[str, bool]:
        fields = {
            "highlight_quote": review.quote,
            "sentence_before": review.contextBefore,
            "sentence_after": review.contextAfter,
            "page_label": review.pageLabel,
            "chapter_label": review.chapterLabel,
            "comment": review.comment,
        }
        if not workspace.update_annotation(annotation_id, fields):
            raise HTTPException(404, "annotation not found")
        return {"updated": True}

    @app.post("/api/pages/{page_id}/approve")
    def approve_page(page_id: str) -> dict[str, bool]:
        page_or_404(page_id)
        try:
            approved = workspace.approve_page(page_id, int(time.time() * 1000))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if not approved:
            raise HTTPException(409, "page must complete OCR review before approval")
        return {"approved": True}

    @app.post("/api/captures/{annotation_id}/approve")
    def approve_capture(annotation_id: str) -> dict[str, bool]:
        try:
            approved = workspace.approve_capture(annotation_id, int(time.time() * 1000))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if not approved:
            raise HTTPException(404, "capture not found")
        return {"approved": True}

    @app.get("/api/books/{isbn13}/publication")
    def publication(isbn13: str) -> dict[str, object]:
        try:
            return build_publication(workspace, isbn13)
        except KeyError as exc:
            raise HTTPException(404, "book not found") from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/api/books/{isbn13}/publication-preview")
    def publication_preview(
        isbn13: str,
        account: str | None = None,
        owner: str | None = None,
        repo: str | None = None,
        branch: str = "main",
    ) -> dict[str, object]:
        require_legacy_github()
        try:
            payload = build_publication(workspace, isbn13)
            result: dict[str, object] = {"payload": payload, "digest": publication_digest(payload)}
            if any(value is not None for value in (account, owner, repo)):
                if not account or not owner or not repo:
                    raise ValueError("account, owner, and repo are required together")
                token = GitHubCredentials().get_token(account)
                content = GitHubContentsClient(token).get(owner, repo, github_book_path(isbn13), branch)
                remote: dict[str, object] | None = None
                if content is not None:
                    remote = json.loads(content.content.decode("utf-8"))
                    validate_contract(remote, "published-book-v1.schema.json")
                    if remote["book"]["isbn13"] != isbn13:
                        raise ValueError("remote publication ISBN does not match the requested book")
                result["remote"] = {"exists": content is not None, "sha": content.sha if content else None}
                result["diff"] = publication_diff(payload, remote)
            return result
        except KeyError as exc:
            raise HTTPException(404, "book not found") from exc
        except (GitHubError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/api/github/credentials")
    def store_credentials(credentials: CredentialUpdate) -> dict[str, bool]:
        require_legacy_github()
        try:
            GitHubCredentials().set_token(credentials.account, credentials.token)
        except Exception as exc:
            raise HTTPException(503, f"Windows Credential Manager is unavailable: {exc}") from exc
        return {"stored": True}

    @app.get("/api/books/{isbn13}/remote")
    def remote_content(isbn13: str, account: str, owner: str, repo: str, branch: str = "main") -> dict[str, object]:
        require_legacy_github()
        try:
            token = GitHubCredentials().get_token(account)
            content = GitHubContentsClient(token).get(owner, repo, github_book_path(isbn13), branch)
            local = build_publication(workspace, isbn13)
            remote = None
            if content is not None:
                remote = json.loads(content.content.decode("utf-8"))
                validate_contract(remote, "published-book-v1.schema.json")
                if remote["book"]["isbn13"] != isbn13:
                    raise ValueError("remote publication ISBN does not match the requested book")
            summary = publication_diff_summary(local, remote)
        except (GitHubError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(502, str(exc)) from exc
        return {"exists": content is not None, "sha": content.sha if content else None, "summary": summary}

    @app.post("/api/books/{isbn13}/publish")
    def publish(isbn13: str, target: PublishRequest) -> dict[str, str]:
        require_legacy_github()
        try:
            payload = build_publication(
                workspace,
                isbn13,
                revision=target.previewRevision,
                updated_at_ms=target.previewUpdatedAtMs,
            )
            if not hmac.compare_digest(publication_digest(payload), target.previewDigest):
                raise PublishConflict("review data changed after preview; preview again before publishing")
            token = GitHubCredentials().get_token(target.account)
            sha = GitHubContentsClient(token).put_json(
                target.owner,
                target.repo,
                github_book_path(isbn13),
                target.branch,
                payload,
                target.expectedSha,
            )
        except KeyError as exc:
            raise HTTPException(404, "book not found") from exc
        except PublishConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except (GitHubError, ValueError) as exc:
            raise HTTPException(502, str(exc)) from exc
        return {"sha": sha, "revision": str(payload["revision"])}

    return app
