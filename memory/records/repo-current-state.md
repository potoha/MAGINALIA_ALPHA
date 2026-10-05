---
id: repo.current-state
updated: 2026-10-06
status: active
kind: state
---

# Repository current state

MAGINALIA_ALPHA is the active Electron + Monaco Desktop implementation repository. Verify the live Git HEAD and worktree before relying on any remembered baseline.

Supported product paths include Workdesk and Project authoring, autosave and local persistence, Reviewer approval into the canonical Private Shelf, QuoteRef resolution by opaque Reviewer `annotationId`, Mods, automatic references, editable Preview, Synced Blocks, local Git-backed History, and D044 resolved Markdown/PDF/DOCX export.

Pre-installer maintenance under D059 removes completed one-shot migration machinery and data, frozen remote Git/GitHub product paths, obsolete duplicated planning/context, accidental backup files, and reproducible tracked package outputs. Keep `sidecars/reviewer/`, `sidecars/contracts/`, `spec/`, and local History. Package build outputs under `packages/*/dist/` are generated and ignored.

The normal Desktop process must not register remote GitHub authentication or discovery IPC. `isomorphic-git` remains a runtime dependency for local History.

Use current source and tests for implementation truth, MAGINALIA_IDE for canonical decisions/planning, and the latest Implementation Handoff Report for exact verification evidence.
