from __future__ import annotations

import base64
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any

import keyring

from .db import Workspace
from .schema import validate_contract

CREDENTIAL_SERVICE = "Digital Marginalia Reviewer GitHub"
MAX_PUBLICATION_BYTES = 10 * 1024 * 1024
PUBLISHED_PROVENANCE_FIELDS = {
    "title",
    "subtitle",
    "authors",
    "publisher",
    "publishedDate",
    "toc",
    "coverUrl",
}

BOOK_DIFF_FIELDS = (
    "title",
    "subtitle",
    "authors",
    "publisher",
    "publishedDate",
    "toc",
    "coverUrl",
    "provenance",
)
HIGHLIGHT_DIFF_FIELDS = (
    "quote",
    "contextBefore",
    "contextAfter",
    "pageLabel",
    "chapterLabel",
    "comment",
    "reviewedAtMs",
)


def github_book_path(isbn13: str) -> str:
    if len(isbn13) != 13 or not isbn13.isascii() or not isbn13.isdigit():
        raise ValueError("a 13-digit ASCII ISBN is required")
    return f"marginalia/v1/books/{isbn13}.json"


class PublishConflict(RuntimeError):
    pass


class GitHubError(RuntimeError):
    pass


class GitHubCredentials:
    def set_token(self, account: str, token: str) -> None:
        if not account.strip() or not token.strip():
            raise ValueError("GitHub account and token are required")
        keyring.set_password(CREDENTIAL_SERVICE, account, token)

    def get_token(self, account: str) -> str:
        token = keyring.get_password(CREDENTIAL_SERVICE, account)
        if not token:
            raise GitHubError(f"no Windows Credential Manager token stored for {account}")
        return token


def build_publication(
    workspace: Workspace,
    isbn13: str,
    *,
    revision: str | None = None,
    updated_at_ms: int | None = None,
) -> dict[str, Any]:
    source = workspace.publication_rows(isbn13)
    if source is None:
        raise KeyError(isbn13)
    book_row, annotations = source
    original = json.loads(book_row["source_json"])
    metadata = original.get("metadata", {})
    source_provenance = metadata.get("provenance", {})
    provenance = {
        field: source
        for field, source in source_provenance.items()
        if field in PUBLISHED_PROVENANCE_FIELDS and isinstance(source, str)
    } if isinstance(source_provenance, dict) else {}
    payload: dict[str, Any] = {
        "schemaVersion": 1,
        "revision": revision or str(uuid.uuid4()),
        "updatedAtMs": updated_at_ms if updated_at_ms is not None else int(time.time() * 1000),
        "book": {
            "isbn13": isbn13,
            "title": metadata.get("title"),
            "subtitle": metadata.get("subtitle"),
            "authors": metadata.get("authors", []),
            "publisher": metadata.get("publisher"),
            "publishedDate": metadata.get("publishedDate"),
            "toc": metadata.get("toc"),
            "coverUrl": metadata.get("coverUrl"),
            "provenance": provenance,
        },
        "highlights": [
            {
                "id": row["source_annotation_id"] or row["id"],
                "quote": row["highlight_quote"],
                "contextBefore": row["sentence_before"],
                "contextAfter": row["sentence_after"],
                "pageLabel": row["page_label"],
                "chapterLabel": row["chapter_label"],
                "comment": row["comment"],
                "reviewedAtMs": row["reviewed_at_ms"],
            }
            for row in annotations
        ],
    }
    highlight_ids = [item["id"] for item in payload["highlights"]]
    if len(highlight_ids) != len(set(highlight_ids)):
        raise ValueError("published highlight IDs must be unique")
    validate_contract(payload, "published-book-v1.schema.json")
    publication_json_bytes(payload)
    return payload


def publication_json_bytes(payload: dict[str, Any]) -> bytes:
    raw = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    if len(raw) > MAX_PUBLICATION_BYTES:
        raise ValueError("published-book JSON exceeds the 10 MiB limit")
    return raw


def publication_digest(payload: dict[str, Any]) -> str:
    return hashlib.sha256(publication_json_bytes(payload)).hexdigest()


def publication_diff_summary(local: dict[str, Any], remote: dict[str, Any] | None) -> dict[str, Any]:
    """Return the legacy compact summary used by the compatibility endpoint."""
    summary = publication_diff(local, remote)["summary"]
    return {
        "bookChanged": summary["bookChanged"],
        "addedHighlights": summary["addedHighlights"],
        "changedHighlights": summary["changedHighlights"],
        "removedHighlights": summary["removedHighlights"],
    }


def _field_change(field: str, before: Any, after: Any) -> dict[str, Any] | None:
    if before == after:
        return None
    return {"field": field, "before": before, "after": after}


def _highlight_field_changes(before: dict[str, Any], after: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        change
        for field in HIGHLIGHT_DIFF_FIELDS
        if (change := _field_change(field, before.get(field), after.get(field))) is not None
    ]


def publication_diff(local: dict[str, Any], remote: dict[str, Any] | None) -> dict[str, Any]:
    """Return deterministic, field-level diff data for the publication preview."""
    remote_book = remote.get("book", {}) if remote is not None else {}
    local_book = local.get("book", {})
    book_fields = [
        change
        for field in BOOK_DIFF_FIELDS
        if (change := _field_change(field, remote_book.get(field), local_book.get(field))) is not None
    ]
    local_highlights = {item["id"]: item for item in local.get("highlights", [])}
    remote_highlights = {item["id"]: item for item in (remote or {}).get("highlights", [])}
    added = [item for item in local.get("highlights", []) if item["id"] not in remote_highlights]
    removed = [item for item in (remote or {}).get("highlights", []) if item["id"] not in local_highlights]
    changed = []
    for item in local.get("highlights", []):
        before = remote_highlights.get(item["id"])
        if before is None:
            continue
        fields = _highlight_field_changes(before, item)
        if fields:
            changed.append({"id": item["id"], "before": before, "after": item, "fields": fields})
    return {
        "summary": {
            "bookChanged": remote is None or bool(book_fields),
            "bookChangedFields": len(book_fields),
            "addedHighlights": len(added),
            "changedHighlights": len(changed),
            "removedHighlights": len(removed),
        },
        "bookFields": book_fields,
        "highlights": {"added": added, "changed": changed, "removed": removed},
    }


@dataclass(frozen=True)
class RemoteContent:
    sha: str
    content: bytes


class GitHubContentsClient:
    def __init__(self, token: str, api_url: str = "https://api.github.com") -> None:
        self.token = token
        self.api_url = api_url.rstrip("/")

    def _url(self, owner: str, repo: str, path: str, branch: str) -> str:
        encoded_path = "/".join(urllib.parse.quote(part, safe="") for part in path.split("/") if part)
        if not encoded_path or path.startswith("/") or ".." in path.split("/"):
            raise ValueError("repository path must be relative and may not contain '..'")
        return (
            f"{self.api_url}/repos/{urllib.parse.quote(owner, safe='')}/"
            f"{urllib.parse.quote(repo, safe='')}/contents/{encoded_path}?ref={urllib.parse.quote(branch, safe='')}"
        )

    def _request(self, request: urllib.request.Request) -> tuple[int, dict[str, Any]]:
        request.add_header("Accept", "application/vnd.github+json")
        request.add_header("Authorization", f"Bearer {self.token}")
        request.add_header("X-GitHub-Api-Version", "2026-03-10")
        request.add_header("User-Agent", "marginalia-pc-reviewer/0.1")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = json.loads(response.read().decode("utf-8"))
                return response.status, body
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return 404, {}
            detail = exc.read().decode("utf-8", errors="replace")[:1000]
            if exc.code == 409:
                raise PublishConflict(f"GitHub rejected the update as a conflict: {detail}") from exc
            raise GitHubError(f"GitHub API returned {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise GitHubError(f"GitHub API request failed: {exc.reason}") from exc

    def get(self, owner: str, repo: str, path: str, branch: str) -> RemoteContent | None:
        status, body = self._request(urllib.request.Request(self._url(owner, repo, path, branch)))
        if status == 404:
            return None
        if body.get("type") != "file" or not isinstance(body.get("sha"), str):
            raise GitHubError("GitHub Contents response is not a file")
        if body.get("encoding") != "base64" or not isinstance(body.get("content"), str):
            raise GitHubError("GitHub Contents response has an unsupported encoding")
        try:
            encoded = "".join(body["content"].split())
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as exc:
            raise GitHubError("GitHub Contents response has invalid base64") from exc
        if len(content) > MAX_PUBLICATION_BYTES:
            raise GitHubError("remote publication exceeds the 10 MiB limit")
        return RemoteContent(body["sha"], content)

    def put_json(
        self,
        owner: str,
        repo: str,
        path: str,
        branch: str,
        payload: dict[str, Any],
        expected_sha: str | None,
    ) -> str:
        current = self.get(owner, repo, path, branch)
        if current is not None and expected_sha != current.sha:
            raise PublishConflict(f"remote blob changed (expected {expected_sha!r}, current {current.sha!r})")
        if current is None and expected_sha is not None:
            raise PublishConflict("remote file no longer exists")
        raw = publication_json_bytes(payload)
        body: dict[str, Any] = {
            "message": f"marginalia: publish {payload['book']['isbn13']} {payload['revision']}",
            "content": base64.b64encode(raw).decode("ascii"),
            "branch": branch,
        }
        if current is not None:
            body["sha"] = current.sha
        url = self._url(owner, repo, path, branch).split("?", 1)[0]
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            method="PUT",
            headers={"Content-Type": "application/json"},
        )
        _, response = self._request(request)
        content = response.get("content")
        if not isinstance(content, dict) or not isinstance(content.get("sha"), str):
            raise GitHubError("GitHub update response did not include the new blob SHA")
        return content["sha"]
