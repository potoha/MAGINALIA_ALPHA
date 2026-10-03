---
id: architecture.core-invariants
updated: 2026-10-04
status: active
kind: invariant
canonical:
  - MAGINALIA_IDE/plan/09_DECISION_LOG.md
  - MAGINALIA_IDE/docs/decisions/
---

# Core architecture invariants

- Local-first.
- Durable research data stays in ordinary portable formats such as Markdown/YAML/JSON/images and explicit repository contracts.
- Cross-product integration uses versioned contracts + adapters rather than internal module coupling.
- Workdesk is a parent/navigation/index concept, not ownership of child Project content.
- Parent Workdesk History must never capture child Project contents or child `.git`.
- Project, Workdesk, and Private Shelf remain distinct authorities.
- Machine-local absolute paths stay machine-local.
- QuoteRef identity remains opaque Reviewer `annotationId`.
- Renderer/presentation rules must not silently mutate Markdown source semantics.
- Primary user is a nontechnical humanities student/researcher/writer.
- Normal UI should not require understanding Git, SQLite, Python, ports, OCR internals, or repository topology.

## Command surface

- Most discrete human-executable actions use stable namespaced command IDs.
- Menu, context-menu, button/toolbar, Command Palette, shortcut, Mod, and future authorized automation surfaces should converge on the same command implementation where they expose the same action.
- Command IDs describe user actions, not UI placement.
- Do not duplicate feature logic per UI surface.
- Command Registry/API is the public action boundary; Controller / Service / IPC / model layers remain responsible for implementation and low-level state transitions.
- Do not mechanically command-wrap continuous pointer/drag state, selection changes, rendering lifecycle, filesystem validation, database access, or similar internal operations unless a concrete user-facing action requires it.

## D032

Production Git/GitHub fetch/pull/push/auth/conflict orchestration is frozen until a human programmer can review that state machine.

OpenCode capability does not supersede D032.
