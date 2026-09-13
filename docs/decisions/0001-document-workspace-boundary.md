# Document workspace boundary

Date: 2026-09-14

## Decision

Before Kaldi treats a selected folder as one Document and the root-level
`.md` / `.markdown` files within it as Manuscripts. `manuscript.md` and then
`manuscript.markdown` are listed first; recursive discovery is deferred until
a concrete writing workflow requires it.

The main process canonicalizes the Document root and owns all filesystem
paths. The renderer receives only opaque Document and Manuscript identifiers
plus display names. Opening a Manuscript resolves those identifiers again in
the main process, revalidates that the file is a direct regular-file child of
the canonical root, and then creates the existing opaque Writing save session.

Document navigation is separate from Writing Core. Writing Core continues to
own open text, edits, dirty state, save snapshots, and save confirmation.
Renderer navigation may replace a dirty Manuscript only after an explicit
Save, Discard, or Cancel decision; Save is accepted only if Writing Core is
clean after the save completes.

## Why

This preserves the old MAGINALIA Document-folder and `manuscript.md`
semantics without carrying over VS Code workspace or TreeView glue. Opaque
identifiers keep the preload API narrow and prevent renderer-controlled path
joins or writes outside the active Document root.

## Deferred

Recursive discovery, ignore rules, New Document, New Manuscript, file
watching, atomic writes, and complete TOCTOU hardening are outside this slice.
