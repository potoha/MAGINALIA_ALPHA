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

## Slice C amendment: QuoteRef authoring

Date: 2026-09-20

For coffee Sapling Slice C Normal flow, the explicit Shelf Insert action writes
only a stable `QuoteRef` marker into the Markdown authoring document:

```text
<!-- maginalia:quote-ref v1 {"quoteId":"<opaque>","mode":"normal"} -->
```

`quoteId` is the opaque Reviewer `annotationId`; it is not required to use the
legacy `ann:ULID` shape.  The marker contains no quote text, `sourceId`, title,
authors, or page metadata.  The serializer emits the keys in deterministic
order and escapes comment-sensitive JSON characters.  The parser is
versioned, accepts only the `normal` mode and known payload fields, and leaves
unknown or malformed markers untouched.  If the Reviewer record later cannot
be resolved, the marker remains valid authoring text; repair and export are
deferred.

The existing literal `insertQuotation` API and its tests remain as a legacy
compatibility path.  They are not used by the Slice C Normal Shelf flow and
are retained until a separately approved migration removes them.
