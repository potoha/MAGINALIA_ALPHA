# Digital Marginalia PC reviewer

This Windows-oriented FastAPI application imports the Android export ZIP, runs an explicitly configured NDLOCR-Lite process, supports human review, and publishes only reviewed text/metadata to a private GitHub repository. Imported page images remain in the local workspace and are never included in the published JSON.

## Install and run

Python 3.11 or newer is required. From this directory:

```powershell
uv sync --extra test
uv run marginalia-review --no-browser
```

The server listens only on `127.0.0.1` and defaults to <http://127.0.0.1:8765/>. Use `--workspace PATH` to choose the SQLite/import directory and `--port PORT` to change the port. Interrupted `RUNNING` OCR rows are reset to `PENDING` when the application starts.

## NDLOCR-Lite 1.2.3

Install NDLOCR-Lite **1.2.3** using its upstream Windows instructions. This project does not silently install or upgrade the OCR engine. Create a JSON configuration that runs the canonical JPEG through the official JSON-only CLI:

```json
{
  "engine": "NDLOCR-Lite",
  "version": "1.2.3",
  "commit": "c3cc7676e7f4613c6b5d51bfae7ca764098424d2",
  "distributionSha256": "f9e615ca1bba70c48fee156e685631cc2ef413f5c18c06fcbb9a949382519668",
  "executableSha256": "SHA-256 of the executable at command[0]",
  "command": ["C:\\path\\to\\ndlocr-lite.exe", "--sourceimg", "{input}", "--output", "{outputDir}", "--json-only"]
}
```

The authoritative release coordinates are recorded in `ndlocr-lite-1.2.3.lock.json`. Before extraction, verify the downloaded Windows archive:

```powershell
(Get-FileHash .\ndlocr_lite_v1.2.3_windows.zip -Algorithm SHA256).Hash.ToLowerInvariant()
```

It must equal the lock file value. Python dependencies for the reviewer itself are fixed by `uv.lock`.

After installation, calculate the configured executable hash and copy it to `executableSha256`:

```powershell
(Get-FileHash C:\path\to\ndlocr-lite.exe -Algorithm SHA256).Hash.ToLowerInvariant()
```

Start with `--ndlocr-config .\ndlocr.json`, or set `MARGINALIA_NDLOCR_CONFIG`. The official 1.2.3 `contents` / `imginfo` JSON is supported directly; `{outputDir}` is the temporary output directory. `{output}` remains available for a wrapper that writes one exact JSON file. Dimensions are checked against the imported page before pixel boxes are normalized. The complete raw JSON is retained in SQLite together with the engine version, release commit, distribution SHA-256, and execution timestamp.

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
