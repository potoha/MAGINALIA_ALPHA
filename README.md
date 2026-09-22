# MAGINALIA α

**MAGINALIA** is a local-first research and writing workspace for the humanities.
This repository is the active implementation line for the independent **Electron + Monaco** desktop application.

> **Status:** pre-alpha
> **Version:** α0.01
> **Codename:** Before Kaldi
> **Current implementation cycle:** coffee Sapling

MAGINALIA is built for students, researchers, and writers who should be able to collect sources and quotations, write, render, and preserve their work without needing Git, terminals, or a general-purpose programming IDE.

## What exists now

The current pre-alpha contains the working substrate for:

- Workdesk / Project navigation and Registry browsing
- multi-document Markdown tabs
- Monaco-based editing
- required local autosave and local persistence
- Shelf search and structured quotation insertion
- generic Source references beyond ISBN-only books
- automatic reference resolution
- rich Markdown rendering, including vertical-writing support
- resolved Markdown export
- a shared command surface and Command Palette
- a small filesystem-based Mod host and first-party Mod experiments
- host-independent Format, Repository, Source, and Writing core packages

The project is intentionally still pre-alpha. Interfaces, Mod APIs, UX details, and storage workflows may change while the main research-writing flow is being proven.

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
├─ mods/                    # first-party / development Mods
├─ plan/                    # planning and implementation history
├─ readme-first.md          # salvage/source rules
├─ requirements.yaml        # machine-readable project requirements
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

- [`readme-first.md`](readme-first.md) — salvage rules and upstream source map
- [`requirements.yaml`](requirements.yaml) — compact machine-readable invariants and verification commands
- [`plan/README.md`](plan/README.md) — planning index

Canonical cross-product decisions still live in `potoha/MAGINALIA_IDE`, especially accepted ADRs and `plan/09_DECISION_LOG.md`. When old implementation and an accepted decision disagree, the accepted decision wins.

## Salvage sources

`MAGINALIA_ALPHA` is the implementation target. Older repositories are evidence and salvage sources, not places to add new Before Kaldi implementation unless explicitly instructed.

- `potoha/MAGINALIA_IDE` — canonical decisions, contracts, Writing Core and Repository Core history
- `potoha/MY_marginallia` — Quote Capture / Reviewer implementation and contracts
- `potoha/Uttate-writer` — MAGINALIA Input legacy implementation
- `potoha/toybox` — historical design context; read-only from the MAGINALIA Workspace project

## Current safety boundary

Git/GitHub production synchronization work is intentionally gated until a human programmer can review the state machine, failure paths, tests, and security boundaries. Local autosave and persistence may continue independently of that gate.

The absence of cloud connectivity must not make local writing unavailable, and credentials must never be stored in portable research repositories.

## License / distribution

Pre-alpha repository. Distribution, installer, third-party notices, and stable Mod compatibility are not yet declared release guarantees. Check current planning and license files before redistributing builds.
