# Quotation resolution boundary

Date: 2026-09-14

## Decision

Before Kaldi keeps the Library root separate from the Document root. The main
process loads each selected Library into an immutable snapshot addressed by an
opaque owner-bound handle. Renderer search returns only the reference allowlist:
annotationId, sourceId, title, authors, and optional page.

privateMemo is searchable only inside the main-process index because the user
explicitly requested memo search. It is never returned as a result field,
snippet, match reason, log value, or insertion content. Raw OCR, capture and
local paths, device metadata, unpublished comments, source location.path,
attribution, and comment remain outside the renderer and are not inserted.

Quotation text is resolved through the dedicated
resolveQuotationForInsert operation only after an explicit Insert action.
That transient response is passed directly to Writing Core, which creates
ordinary Markdown provenance from the public allowlist. Stale Library handles
and stale Writing targets fail closed.

## Why

Separating roots and keeping the snapshot main-owned prevents renderer
filesystem access and keeps reference search distinct from source-text
disclosure. A dedicated resolve operation makes the user action that turns a
reference into authored Markdown explicit and auditable.

## Deferred

Source location.path, attribution/comment projection, raw OCR/capture
workflows, semantic or fuzzy search, caching, and broader Library UI remain
deferred until a concrete workflow requires them.
