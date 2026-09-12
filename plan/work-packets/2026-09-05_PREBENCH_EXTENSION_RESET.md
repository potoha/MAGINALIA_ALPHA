# Pre-benchmark VS Code Extension Reset

**Date:** 2026-09-05  
**Status:** Approved implementation work packet  
**Target repository:** `potoha/MAGINALIA_IDE`  
**Implementation owner:** Codex / development environment

## Goal

Before the GPT-6 Astra Writing Core benchmark, purge **all unnecessary legacy material in `MAGINALIA_IDE`**, not only the current unusable Alpha 0.1 VS Code extension application layer. Replace the extension with the smallest buildable, activatable MAGINALIA scaffold and leave the active repository tree containing only current canonical contracts, current infrastructure, and material with a concrete present-day purpose.

The benchmark must start from a clean product surface, not from a requirement to rescue historical UI/application orchestration.

## Why this reset is necessary

The current `extensions/maginalia` application layer has accumulated unrelated Alpha 0.1 responsibilities in one extension:

- Research Project creation
- Note / Book / Annotation / Output creation
- Git Update and Sync orchestration
- GitHub CLI repository operations
- Publish orchestration and Pages setup
- Capture package preview
- vertical/manuscript preview
- multiple Activity Bar views
- publishing webviews
- direct adapter glue for format and publisher runtimes

This code is useful as historical evidence, but it is not a coherent Writing Core and must not consume benchmark reasoning through preservation work.

Git history is the archive. Do not create an in-repository `legacy/` copy.

## Governing decision

Legacy status is **not** a retention reason.

A file, dependency, fixture, test, command, compatibility wrapper, generated artifact, or document may remain in the active tree only when at least one of these is true:

1. it is part of the current canonical portable-data contract,
2. it is required by the current build/distribution path,
3. it is required by a currently supported user workflow,
4. it is the current normative architecture/decision record,
5. it is a reusable independent implementation that the current architecture actually depends on.

Everything else should be deleted. Git history is the archive.

Do not create `legacy/`, `archive/`, `old/`, backup copies, commented-out implementations, compatibility shims, or historical fixtures solely to preserve removed behavior.

Preserve authoritative, independent assets only where they satisfy the rules above:

- `spec/**`
- `packages/format/**`
- `packages/publisher/**`
- `overlay/**`
- `scripts/overlay.mjs`
- Accepted ADRs and Decision Log
- portable fixtures and schemas outside the extension

Do not preserve an extension-local implementation merely because it exists today.

## Scope

### 0. Repository-wide legacy inventory and purge

Before rewriting the scaffold, inspect the full `MAGINALIA_IDE` tree for obsolete material.

Delete, when no current dependency or normative contract requires them:

- obsolete Alpha 0.1 implementation documents
- historical requirements that describe a removed application surface
- obsolete extension-only fixtures and snapshots
- tests that assert removed behavior or obsolete identifiers
- generated bundle files that should be build outputs rather than maintained source
- unused dependencies and scripts
- dead compatibility wrappers
- abandoned prototypes or duplicate implementations
- stale example projects created solely for the removed Alpha flow
- old command/view contribution declarations
- stale documentation links and README sections pointing at removed behavior

If a historical document contains one still-current rule, migrate that rule into the appropriate current canonical document first, then delete the historical document.

Do not delete Accepted ADRs or Decision Log history merely because they are old; supersede decisions explicitly when necessary.

### 1. Destructive extension cleanup

Within `extensions/maginalia`:

- remove or rewrite the current `src/extension.ts`
- remove the current `src/core.ts`
- remove the current `src/webviews.ts`
- remove extension-local Capture import/application code that exists only for the old Alpha 0.1 flow
- remove tests whose only purpose is to freeze the legacy command/view surface
- remove commands, views, activation behavior and runtime dependencies that exist only for the legacy Alpha 0.1 feature pile

Do not retain dead compatibility wrappers.

### 2. Recreate only a bootstrap scaffold

Keep the existing extension/package identity and distribution path so the Code-OSS overlay and stock VS Code proof still have one source tree to consume.

The replacement scaffold should do only enough to prove:

1. the extension installs/builds,
2. it activates without error in stock VS Code,
3. the same built extension can be bundled into the MAGINALIA Code-OSS overlay,
4. the extension contributes a minimal MAGINALIA product entry point,
5. no Git, GitHub, Publish, Capture, OCR, ISBN, or old Research Project CRUD flow runs at activation.

Prefer one tiny product entry surface over fake feature stubs.

Do not pre-implement the Writing Core benchmark.

### 3. Package manifest cleanup

Keep:

- package identity `maginalia`
- `maginalia.*` command namespace
- MAGINALIA branding asset if still valid
- build/bundle/test scripts required by the repository

Remove legacy commands/views that no longer have an implemented behavior.

Do not keep command IDs solely to satisfy old smoke tests.

### 4. Test reset

Replace legacy smoke assertions with tests that protect the new baseline:

- bundle entry exists
- extension activation succeeds
- package manifest contains only implemented contributions
- no legacy Git/GitHub/Publish/Capture command surface is accidentally restored
- overlay verification still accepts the extension bundle

Tests should protect architecture, not freeze historical UI labels.

## Explicit deletions from the baseline product surface

The following list is a **minimum**, not the complete purge boundary. Codex must delete additional dead legacy discovered during the repository-wide inventory.

The pre-benchmark scaffold must not expose these legacy capabilities:

- `maginalia.project.create`
- `maginalia.note.create`
- `maginalia.book.add`
- `maginalia.annotation.add`
- `maginalia.output.create`
- `maginalia.update.create`
- `maginalia.sync`
- `maginalia.publish`
- `maginalia.capture.import`
- legacy vertical/manuscript preview commands
- legacy Library / Projects / Inbox / Sources / Reviews tree set

These identifiers remain recoverable from Git history. Their removal does not forbid future features with different, product-appropriate contracts.

## Non-goals

- implementing the rich Markdown editor
- implementing the outline processor
- implementing History UX
- implementing Library search
- implementing Ctrl+Q
- implementing PDF/DOCX/HTML export
- redesigning Code-OSS workbench chrome
- changing canonical portable data contracts
- changing Quote Capture contracts
- migrating old Alpha 0.1 project data
- preserving application-level backward compatibility with the removed extension UI

Those belong to the benchmark or later migration work.

## Compatibility rule

The reset may break the old Alpha 0.1 extension UI and command surface.

It must not intentionally break:

- portable files governed by canonical format contracts,
- the Code-OSS overlay build path,
- independent packages,
- or repository-level build/test commands except where tests are deliberately updated to the new baseline.

No user-owned durable data migration is required merely because an obsolete UI command disappears.

## Benchmark handoff rule

GPT-6 Astra must treat the reset scaffold as a clean starting point.

It must **not**:

- reconstruct removed legacy extension flows merely because they exist in Git history,
- optimize for preserving old command IDs,
- assume the old `core.ts` orchestration is the preferred architecture,
- or spend benchmark context rescuing historical Alpha 0.1 behavior.

It may inspect old code only when historical implementation evidence answers a specific question.

## Acceptance criteria

The Codex implementation is complete when:

- [ ] a repository-wide inventory was performed, not only `extensions/maginalia`
- [ ] every retained legacy-looking artifact has a concrete current justification
- [ ] obsolete historical requirements/implementation documents are removed after current rules are migrated
- [ ] unused dependencies/scripts/generated source artifacts tied only to removed behavior are removed
- [ ] no `legacy/`, `archive/`, `old/`, backup copy, or compatibility graveyard is added

- [ ] legacy application orchestration is removed from `extensions/maginalia`
- [ ] no in-repo legacy copy is created
- [ ] a minimal extension scaffold builds and activates
- [ ] stock VS Code development/packaging proof passes
- [ ] Code-OSS overlay bundle verification passes
- [ ] repository checks relevant to the reset pass
- [ ] legacy command/view smoke tests are removed or rewritten
- [ ] no old Git/GitHub/Publish/Capture behavior runs from the scaffold
- [ ] the resulting code is small enough for a new agent to understand quickly
- [ ] a short implementation report lists deleted responsibilities and retained infrastructure

## Verification commands

Use the repository's current supported commands. At minimum, verify the extension build/bundle path and overlay tests that are actually applicable after the reset.

Do not broaden the task into unrelated dependency or build-system work.

## Implementation report

Return:

1. files deleted/replaced,
2. retained independent assets,
3. final extension responsibilities in one sentence,
4. build/test results,
5. any blocker in the stock VS Code / Code-OSS dual path,
6. any old requirement or test that had to be explicitly superseded.
