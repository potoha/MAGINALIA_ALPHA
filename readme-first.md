# READ ME FIRST — MAGINALIA α0.01 "Before Kaldi"

> Repository: `MAGINALIA_ALPHA`  
> Product: **MAGINALIA**  
> Version: **α0.01**  
> Codename: **Before Kaldi**  
> Purpose: Existing MAGINALIA assets are salvaged into a new Electron + Monaco desktop architecture.  
> This repository is a new mainline. Existing repositories are sources to inspect and salvage from, not the implementation target.

---

## 0. Read this before touching code

`MAGINALIA_ALPHA` does **not** start from zero.

Before implementing a feature, first check whether the behavior, contract, data model, test, or design already exists in the repositories listed below.

The initial salvage targets are:

1. **Writing Core**
2. **MAGINALIA Quote Capture**
3. **Capture Reviewer**
4. **Repository Core**

The goal is not to mechanically copy old code.  
The goal is to preserve useful contracts, domain logic, tested behavior, data formats, security boundaries, and UX decisions while replacing obsolete host-specific implementation where necessary.

For each salvaged component, classify it as:

- **KEEP** — usable with little or no change
- **ADAPT** — useful logic, but host/UI integration must change
- **REWRITE** — behavior/contract should survive, implementation should not
- **DROP** — obsolete or incompatible with the new architecture

Do not re-implement a solved problem before checking the sources below.

---

# 1. Canonical source repositories

## A. MAGINALIA IDE

Repository:

`https://github.com/potoha/MAGINALIA_IDE`

This is the primary source for MAGINALIA-wide contracts, accepted architectural decisions, Writing Core, and Repository Core.

### Read first

- `README.md`
- `plan/README.md`
- `plan/09_DECISION_LOG.md`
- `docs/architecture.md`
- `docs/requirements.md`
- `docs/decisions/`
- `spec/`
- `packages/format/`

When implementation and architecture disagree, accepted ADRs / canonical contracts / current decision log take priority over old implementation.

---

## B. MAGINALIA Quote Capture

Repository:

`https://github.com/potoha/MY_marginallia`

Legacy repository name: `MY_marginallia`

This repository contains two Capture lines:

- `APK/` — Android Capture + Windows PC Reviewer
- `miniapp/` — browser / LINE MINI App Capture

The two lines share the basic flow:

`ISBN -> capture -> OCR -> human review -> portable record`

but their storage/transfer contracts are not automatically interchangeable.

Read the relevant README before copying implementation between them.

---

## C. MAGINALIA Input

Repository:

`https://github.com/potoha/Uttate-writer`

Legacy product/repository naming may still use `Writer`.

This repository is **not an initial Before Kaldi salvage target**, but remains an official MAGINALIA source and may later provide input assistance, normalization, review UI, provider, or Context Bundle logic.

Do not rename existing package/module/CLI identifiers merely because the product-level canonical name is now **MAGINALIA Input**.

---

## D. toybox

Repository:

`https://github.com/potoha/toybox`

Purpose:

- historical discussion
- design intent
- discarded alternatives
- second-brain context
- reasons behind current product decisions

### STRICT READ-ONLY

Never modify toybox from this project.

Allowed:

- search
- read files
- inspect history
- recover design context

Forbidden:

- edit/create/delete files
- commits
- branches
- push
- Issues / PRs
- merge
- tags / releases
- any repository-changing operation

toybox is supporting memory, not canonical specification.

---

# 2. Salvage target: Writing Core

Repository:

`potoha/MAGINALIA_IDE`

## Start here

- `docs/writing-core.md`
- `docs/writing-core-verification.md`
- `BENCH_INTERFACES.md`
- `BENCH_HANDOFF.md`
- `BENCH_PLAN.md`

## Main implementation area

`extensions/maginalia/src/`

Important paths include:

- `extensions/maginalia/src/host.ts`
- `extensions/maginalia/src/extension.ts`
- `extensions/maginalia/src/protocol.ts`
- `extensions/maginalia/src/library.ts`
- `extensions/maginalia/src/presentation.ts`
- `extensions/maginalia/src/editor/`
- `extensions/maginalia/src/webview/`

Tests and fixtures:

- `extensions/maginalia/test/`
- `extensions/maginalia/test/browser-smoke/`
- `examples/writing-core-library/`

## Behavior worth preserving

Before Kaldi should treat these as existing design assets, not blank problems:

- ordinary Markdown on disk is authoritative
- Document / Manuscript workflow
- explicit New / Open / Save behavior
- versioned editing and conflict/recovery behavior
- host undo / redo semantics
- quotation search
- Library adapter
- quotation insertion with privacy-aware provenance
- presentation state stored outside canonical Markdown
- refusal / fallback behavior for unsupported Markdown
- existing focused tests and verification evidence

### Important migration note

The existing implementation is a VS Code custom editor using VS Code `TextDocument`, `WorkspaceEdit`, webview messaging, and ProseMirror.

**Those host-specific mechanisms are not automatically canonical for Before Kaldi.**

Preserve behavior and invariants first.  
Electron + Monaco integration should be allowed to replace VS Code / webview / ProseMirror-specific machinery.

---

# 3. Salvage target: Quote Capture

Repository:

`potoha/MY_marginallia`

## Repository entry points

- `README.md`
- `APK/README.md`
- `miniapp/README.md`

## Existing Android / PC line

`APK/`

This is the existing Android Capture + Windows Reviewer workspace.

Inspect:

- Capture implementation under `APK/`
- `APK/contracts/`
- capture/export schemas
- ISBN / bibliographic handling
- OCR handoff
- annotation/publication data
- tests associated with these contracts

## Web / MINI App line

`miniapp/`

Inspect this line when its implementation is useful, particularly for:

- browser/mobile capture
- ISBN scanning
- openBD lookup
- camera capture
- portable JSON flow
- GitHub-oriented transfer

Do **not** silently merge the `APK/` and `miniapp/` persistence models.  
Read their contracts first and decide explicitly what Before Kaldi adopts.

---

# 4. Salvage target: Capture Reviewer

Primary implementation repository:

`potoha/MY_marginallia`

## Main implementation path

`APK/reviewer/`

Important code area:

`APK/reviewer/src/marginalia_reviewer/`

Known files include:

- `app.py`
- `candidates.py`
- `ui.py`

Also inspect:

- `APK/contracts/`
- reviewer tests
- publication/export behavior
- OCR orientation and candidate-selection logic
- human confirmation/edit workflow

## Canonical UX / product specification

Repository:

`potoha/MAGINALIA_IDE`

Read:

- `plan/17_CAPTURE_REVIEW_UX_SPEC.md`

The Reviewer should be salvaged primarily as:

- workflow
- state transitions
- review semantics
- candidate selection logic
- contract boundaries
- human-in-the-loop behavior

The old FastAPI / Python / embedded UI arrangement is **not automatically required** for Before Kaldi.

---

# 5. Salvage target: Repository Core

Repository:

`potoha/MAGINALIA_IDE`

## Read first

- `docs/repository-core.md`
- `docs/repository-core-contract.md`
- `docs/decisions/0006-private-repository-core.md`
- `BENCH_REPOSITORY_CORE_PLAN.md`
- `BENCH_REPOSITORY_CORE_REPORT.md`
- `BENCH_REPOSITORY_CORE_HANDOFF.md`

## Main implementation path

`extensions/maginalia/src/repository/`

Known implementation files include:

- `extensions/maginalia/src/repository/domain.ts`
- `extensions/maginalia/src/repository/templates.ts`
- `extensions/maginalia/src/repository/github.ts`

Tests:

- `extensions/maginalia/test/repository-domain.test.ts`
- `extensions/maginalia/test/repository-github.test.ts`
- other `repository-*` tests under `extensions/maginalia/test/`
- `extensions/maginalia/test/repository-live.mjs`

## Behavior / contracts worth preserving

- exactly three user-facing repository kinds:
  - Project
  - Workbench
  - Private Shelf
- local-first creation
- cloud account is not required for local writing
- Save and Sync are separate operations
- MAGINALIA-created remote storage is private
- `.maginalia/repository.json` is the portable repository identity
- Project / Workbench keep ordinary Markdown as authored content
- Private Shelf feeds the Library adapter
- History uses ordinary Git history rather than a second content database
- remote-ahead / divergent work must not silently overwrite local work
- History / Restore produce fresh copies
- incomplete restores are explicitly marked and rejected by normal entry points
- secrets/tokens must not be written into portable project data
- GitHub is an adapter, not the user's mental model

### Important migration note

Current Repository Core is integrated with the VS Code host and VS Code GitHub authentication.

For Before Kaldi:

- preserve the domain model, templates, identity, safety behavior, privacy boundaries, tests, and local-first semantics
- replace VS Code-specific host/authentication glue where necessary
- do not expose Git concepts merely because the implementation uses Git internally

---

# 6. Information priority

When sources disagree, use this order:

1. **The user's latest explicit instruction in the current conversation**
2. `MAGINALIA_IDE` accepted ADR / canonical contract / Decision Log
3. current active sprint / product goal / approved specification
4. current implementation and tests in the relevant main repository
5. open PR / active branch proposal
6. historical planning documents
7. toybox discussion / historical notes
8. ChatGPT memory or summaries

Never revive an older idea merely because it is easier to find in code.

---

# 7. Rules for Before Kaldi salvage work

## Existing repositories are upstream evidence

For work on `MAGINALIA_ALPHA`, treat existing repositories as **reference/salvage sources**.

Do not modify an old repository merely to make salvage easier.

All new Before Kaldi implementation belongs in:

`MAGINALIA_ALPHA`

unless the user explicitly orders otherwise.

## Preserve contracts before implementations

Prefer this order:

1. identify behavior
2. identify canonical data/contract
3. identify tests
4. identify security/privacy invariants
5. identify reusable domain logic
6. only then inspect host/UI implementation

A clean rewrite that preserves proven behavior is preferable to copying an obsolete integration layer.

## Do not copy VS Code architecture accidentally

Before Kaldi uses a new desktop architecture centered on:

- Electron
- Monaco Editor
- a thin desktop shell
- host-independent core packages where practical

VS Code extension APIs, Custom Editor APIs, webview bridges, and Code-OSS assumptions are historical implementation details unless explicitly retained by a new architectural decision.

## Do not copy credentials or secrets

Never migrate:

- GitHub access tokens
- authentication sessions
- secrets
- machine-specific credentials
- cached private credentials

Migration concerns behavior and source code, not developer state.

---

# 8. Minimum inspection sequence for an implementation task

Before implementing any feature in `MAGINALIA_ALPHA`:

1. identify which existing core owns the behavior
2. read the relevant canonical doc / ADR
3. inspect its current implementation
4. inspect relevant tests
5. classify candidate assets as KEEP / ADAPT / REWRITE / DROP
6. record migration decisions when they affect architecture or compatibility
7. implement in `MAGINALIA_ALPHA`
8. verify the preserved behavior with tests

Do not crawl every old repository for every task.  
Read only what is needed, but check the canonical contract before making cross-product decisions.

---

# 9. Current Before Kaldi mission

The first integrated target is:

> Bring the useful MAGINALIA core assets into a new Electron + Monaco desktop application without inheriting unnecessary VS Code / Code-OSS coupling.

Initial integration order:

1. **Writing Core**
2. **Capture**
3. **Capture Reviewer**
4. **Repository Core**

The first vertical slice should prove that existing MAGINALIA behavior can survive the new host before expanding product scope.

---

# 10. One-line rule

> **Search first, salvage deliberately, preserve contracts and tested behavior, rewrite obsolete host glue, and put all new Before Kaldi code in `MAGINALIA_ALPHA`.**
