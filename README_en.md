# MAGINALIA desktop α1 — Before Kaldi

[日本語 README](README.md)

**MAGINALIA** is a local-first research and writing workspace for the humanities.
This repository is the active implementation line for the independent **Electron + Monaco** desktop application.

> **Status:** α1 in development. Windows installer acceptance on the target machine is pending.

MAGINALIA is built for students, researchers, and writers who should be able to collect sources and quotations, write, render, and preserve their work without needing Git, terminals, or a general-purpose programming IDE.

## What exists now

The current α1 development build contains the working substrate for:

- Workdesk / Project navigation and Registry browsing
- multi-document Markdown tabs
- Monaco-based editing
- required local autosave and local persistence
- Shelf search and structured quotation insertion
- Reviewer approval into the canonical Private Shelf
- generic Source references beyond ISBN-only books
- automatic reference resolution
- rich Markdown rendering, including vertical-writing support
- resolved Markdown, PDF, and DOCX export
- local Git-backed History for Projects, Workdesks, and the Private Shelf
- a shared command surface and Command Palette
- a small filesystem-based Mod host and first-party Mod experiments
- host-independent Format, Repository, Source, and Writing core packages

This repository is the α1 development source. Windows installer, first-run setup, and target-environment acceptance are in progress. Interfaces, Mod APIs, UX, and storage workflows may change.

## Core principles

1. **Local first.** Ordinary local files remain usable even when a network service is unavailable.
2. **Portable research data.** Markdown, YAML, JSON, images, and Git-backed history are durable formats. Electron and Monaco are implementation details.
3. **Autosave is baseline safety.** Editing persists locally without requiring a manual Save ritual. Autosave is separate from Git history or remote synchronization.
4. **Humanities UX first.** Normal UI describes research and writing work rather than exposing implementation jargon unnecessarily.
5. **Simple outside, explicit inside.** External services and specialist tools live behind bounded adapters and replaceable capabilities.
6. **AI is optional.** MAGINALIA must remain useful without an AI provider.
7. **Mods are capabilities, not ambient privilege.** Project content is data, not executable code.

## Repository layout

```text
MAGINALIA_ALPHA/
├─ apps/desktop/            # Electron desktop application
├─ packages/format/         # portable format contracts
├─ packages/repository-core/
├─ packages/source-core/
├─ packages/writing-core/
├─ spec/                    # authoritative portable format schemas
├─ sidecars/reviewer/       # Python / FastAPI Reviewer
├─ mods/                    # first-party / development Mods
├─ docs/                    # maintained implementation and contract guidance
├─ memory/                  # retrieval-oriented development context
├─ package.json
└─ package-lock.json
```

## Development

This is an npm workspace.

```bash
npm ci
npm run typecheck
npm run build
npm test
npm start
```

Useful smoke suites include:

```bash
npm run smoke
npm run smoke:writing
npm run smoke:workspace
npm run smoke:quotation
npm run smoke:repository
npm run smoke:shelf
npm run smoke:export
```

For exact dependency versions, use `package-lock.json` and package manifests as the source of truth.

## Read before changing architecture

- [`AGENTS.md`](AGENTS.md) — repository workflow, invariants, and source authority
- [MAGINALIA_IDE Decision Log](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/09_DECISION_LOG.md) — canonical cross-product decisions
- [MAGINALIA_IDE Alpha Close Sequence](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/27_ALPHA_CLOSE_SLICE_SEQUENCE.md) — canonical alpha-close planning

Canonical cross-product decisions, ADRs, and planning live in `potoha/MAGINALIA_IDE`. Package manifests and `package-lock.json` are the dependency authority. When old implementation and an accepted decision disagree, the accepted decision wins.

## Salvage sources

`MAGINALIA_ALPHA` is the implementation target. Older repositories are evidence and salvage sources, not places to add new Before Kaldi implementation unless explicitly instructed.

- `potoha/MAGINALIA_IDE` — canonical decisions, contracts, Writing Core and Repository Core history
- `potoha/MY_marginallia` — Quote Capture / Reviewer implementation and contracts
- `potoha/Uttate-writer` — MAGINALIA Input legacy implementation
- `potoha/toybox` — historical design context; read-only from the MAGINALIA Workspace project

## Current safety boundary

Production Git/GitHub authentication, discovery, fetch, push, provisioning, and restore are frozen by D032. Local Git-backed History remains supported. Local autosave and persistence continue independently of the remote-sync gate.

The absence of cloud connectivity must not make local writing unavailable, and credentials must never be stored in portable research repositories.

## License / distribution

MAGINALIA_ALPHA code owned by **beyond the Word. / MAGINALIA PROJECT** is released under the [MIT License](LICENSE), unless a file or component states otherwise.

The **MAGINALIA** name, wordmark, logo, visual identity, and other project/product branding are not granted by the MIT License. See [NOTICE](NOTICE).

Third-party components remain under their respective licenses. User-created manuscripts, notes, quotations, images, Project data, and other research content are not relicensed merely by being created or processed with MAGINALIA.

This repository is not a public installer download. Acceptance of Windows installation, upgrade, and uninstall behavior remains pending.
