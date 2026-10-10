# Digital Marginalia PC reviewer

This Windows-oriented FastAPI application imports the Android export ZIP, runs an explicitly configured NDLOCR-Lite process, supports human review, and publishes only reviewed text/metadata to a private GitHub repository. Imported page images remain in the local workspace and are never included in the published JSON.

## Install and run

Python 3.11 or newer is required. From this directory:

```powershell
uv sync --extra test
uv run marginalia-review --no-browser
```

The server listens only on `127.0.0.1` and defaults to <http://127.0.0.1:8765/>. Use `--workspace PATH` to choose the SQLite/import directory and `--port PORT` to change the port. Interrupted `RUNNING` OCR rows are reset to `PENDING` when the application starts.

## NDLOCR-Lite 1.3.1

The Windows Desktop package uses the official NDLOCR-Lite 1.3.1 source at commit `6feccb29e33c2467ea48894e66502a7788ae2b2d` to build an isolated CPU command-line runtime. The upstream tag's Python package metadata says 1.3.0; its release workflow stamps 1.3.1 before building, and the MAGINALIA runtime repeats that stamp. The pinned source inputs, model/config hashes, Python dependency lock, and license-source coordinates are recorded in `ndlocr-lite-1.3.1.lock.json` and `ndlocr-runtime/uv.lock`.

NDLOCR-Lite is an optional installer component. MAGINALIA Core and non-OCR Reviewer functions remain available if it is not selected. The packaged Desktop verifies the runtime manifest and executable before generating its managed `ndlocr.json` in Electron's application-data directory. It does not create the file when the optional payload is absent, and it preserves configuration files not marked as MAGINALIA-managed. One narrow upgrade exception applies: the exact documented 1.2.3 configuration (official version, commit, archive hash, and default CLI arguments) is backed up byte-for-byte beside the settings file before it is replaced with the managed 1.3.1 configuration. Custom commands, extra settings, malformed files, and other configurations remain untouched and require attention. The OCR process is launched by absolute executable path with shell execution disabled; its executable and distribution-manifest hashes are checked before use.

The managed configuration records the absolute `manifestPath`, its SHA-256 as `distributionSha256`, the pinned source commit/version, the executable SHA-256, and the native CLI arguments `--sourceimg {input} --output {outputDir} --json-only --device cpu`. NDLOCR-Lite writes `<input-name>.json` inside that output directory; the adapter accepts that file only when exactly one JSON result is present. The adapter accepts the upstream 1.3.1 `contents` / `imginfo` structure, validates image dimensions and region geometry, and records the complete raw result and version provenance for new OCR results. Previously saved OCR provenance is not rewritten.

For development-only direct Reviewer runs, `--ndlocr-config PATH` or `MARGINALIA_NDLOCR_CONFIG` can select an explicit configuration. A missing configuration only disables OCR; it does not prevent non-OCR Reviewer operations. The installed application generates configuration automatically when its verified optional runtime is present.

The review screen overlays read-only mobile OCR boxes in blue, editable NDL OCR boxes in green, and original annotation strokes in red. Select an NDL box to drag it or resize its lower-right handle, then correct its text in the **Selected NDL OCR text** field; **Add NDL region**, **Delete selected**, and **Save regions** persist the edited normalized boxes and text to SQLite.

## GitHub credentials and publishing

GitHub publication uses the private repository `<GitHub login>/my-MAGI-shelf` on the `main` branch. Use a fine-grained personal access token that can read and write repository contents for that repository. Store it without putting it on the command line:

```powershell
uv run marginalia-review --set-github-token YOUR_GITHUB_LOGIN
```

The prompt is hidden, and `keyring` stores the token under `Digital Marginalia Reviewer GitHub` in Windows Credential Manager. The browser publication panel collects account, owner, repository, branch, and imported book. **Preview** displays the exact image-free JSON, the remote SHA, and a deterministic field-level diff. The raw JSON remains available in a collapsed helper panel, and **Confirm publish** rejects stale preview data before writing it. The UI keeps an English/Japanese choice in browser `localStorage`. The API provides:

- `GET /api/books/{isbn13}/remote` to read the current blob SHA;
- `GET /api/books/{isbn13}/publication` to inspect the image-free contract payload;
- `GET /api/books/{isbn13}/publication-preview` to obtain the exact payload and preview digest; pass `account`, `owner`, `repo`, and optional `branch` to include the remote SHA and integrated bibliography/highlight diff;
- `POST /api/books/{isbn13}/publish` to create or update via the GitHub Contents API.

The path is fixed to `marginalia/v1/books/<isbn13>.json`; requests cannot override it. For an update, send the SHA returned by the preceding read as `expectedSha`. A changed or deleted remote blob returns HTTP 409 instead of overwriting concurrent work. Create requests use `expectedSha: null`. Commit messages are `marginalia: publish <isbn13> <revision>`.

Re-importing the same ISBN starts a replacement review generation. Publication uses the newest import only; the Preview removed-count must be reviewed before confirming, especially before all pages in that generation are approved.

The local reviewer also provides `GET /api/search`. It reads approved/reviewed annotations directly from SQLite and accepts `q`, `isbn`, `book`, `status`, `limit`, and `offset`. `q` is an escaped literal substring search over the final quote, comment, title, authors, and page label; this keeps Japanese substring matching reliable without adding a tokenizer or search service. The default status is `APPROVED`, while an explicit status such as `ALL` can inspect other review states. Results contain only the quote, review metadata, book metadata, and page/annotation identifiers needed to reopen the review; OCR JSON, image paths, and provenance are not returned.

## Security and validation

All state-changing browser requests require the per-process CSRF cookie/header pair. Non-loopback `Host` values and mismatched `Origin` values are rejected. ZIP import enforces the manifest v1 JSON Schema, size/entry/compression-ratio limits, unique safe paths, regular files only, declared JPEG membership, and SHA-256 equality before extraction. Publication is validated against `published-book-v1.schema.json` before any GitHub write.

## Tests

```powershell
uv run pytest
```
