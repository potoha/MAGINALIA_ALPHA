# MAGINALIA_ALPHA — Codex repository instructions

## Purpose

This repository is the active MAGINALIA Desktop implementation target.

Codex may directly inspect, edit, test, run, and commit implementation work when the user gives an explicit work order.

Do not treat historical chat context as product truth when current repository evidence or accepted MAGINALIA_IDE decisions exist.

## Task bootstrap

Before implementation:

1. Verify the actual Git HEAD and worktree state.
2. If the work order specifies an `expected_base_commit`, require an exact match.
   - If it differs, stop with `STALE_BASE_COMMIT`.
   - Do not silently reset, rebase, or reinterpret the task against another base.
3. Read this file first.
4. Read `memory/README.md` and `memory/index.json`.
5. Retrieve only the memory records relevant to the current task.
6. Inspect the current implementation and tests before making assumptions.
7. Read only the relevant canonical MAGINALIA_IDE plans/ADRs needed for the task.

Do not preload the entire `memory/` directory.

## Structured memory

The repository uses retrieval-oriented project memory.

Use:

```text
node memory/query.mjs "<task query>"
```

Prefer a small relevant set of records rather than loading every record.

Memory is derived context, not specification.

Authority order:

1. latest explicit Product Owner instruction;
2. accepted MAGINALIA_IDE Product Spec / ADR / Decision Log / active plan;
3. current repository implementation and tests;
4. structured external memory;
5. previous Implementation Handoff Report;
6. historical notes or conversational recollection.

When memory conflicts with maintained specifications or current implementation evidence, memory loses.

## Repository roles

### MAGINALIA_ALPHA

This repository is the Desktop implementation target.

Implementation, tests, integration changes, and product-facing Desktop work belong here.

### MAGINALIA_IDE

Canonical architecture, product decisions, ADRs, milestone plans, and cross-product contracts.

Use only the relevant files for the active task.

### MY_marginallia

Quote Capture / legacy Reviewer salvage and behavioral reference where explicitly requested.

It is not automatically:
- a runtime dependency;
- current Desktop architecture;
- source of truth over accepted MAGINALIA_IDE decisions.

Do not introduce a runtime dependency on another local repository unless the Product Owner explicitly changes that architecture.

## Engineering language

Engineering artifacts are English-first:
- technical plans;
- implementation notes;
- code comments where appropriate;
- commit messages;
- Implementation Handoff Reports.

Do not translate exact Japanese product data for engineering convenience.

Preserve Japanese where semantically relevant, including:
- UI strings;
- user-facing messages;
- document contents;
- quotations;
- filenames/directories;
- Japanese search/input behavior;
- fixtures/corpora.

Text handling is Unicode-first / UTF-8.

ASCII-only assumptions are prohibited unless an unavoidable external limitation is documented.

## Core product invariants

- Local-first research data.
- Durable user data remains in ordinary portable formats such as Markdown/YAML/JSON/images and explicit contracts.
- Cross-product integration uses versioned contracts + adapters rather than internal implementation coupling.
- Workdesk organizes Projects but does not own child Project contents/history.
- Project, Workdesk, and Private Shelf remain distinct authorities.
- QuoteRef identity remains the opaque Reviewer `annotationId`.
- Renderer/presentation changes must not silently mutate Markdown source semantics.
- Normal-user flows must not require Git, Node, Python, PowerShell, PATH editing, npm, pip, or other developer setup in the final product.
- Machine-local absolute paths must not become canonical portable project/user data.

## Git/GitHub freeze

Decision D032 remains authoritative.

Do not implement or reopen production Git/GitHub fetch/pull/push/auth/conflict orchestration unless the Product Owner explicitly changes that decision.

Local development Git operations required to implement and commit work are allowed.

## Implementation behavior

For substantial work:

- inspect before editing;
- preserve working behavior outside the requested scope;
- prefer narrow changes over broad rewrites;
- reuse existing contracts and adapters;
- do not introduce parallel sources of truth without an explicit product decision;
- do not opportunistically implement adjacent roadmap slices;
- treat user-visible security/data/identity boundaries as product constraints, not optional cleanup.

When an existing generated or partial implementation is present, audit it before trusting it.

## Testing and evidence

Choose an efficient verification order.

Use fast unit/contract tests where useful, but do not let mocks substitute for evidence that requires:
- a real child process;
- real Electron/Desktop behavior;
- persistence across restart;
- OS/path behavior;
- packaging/runtime boundaries.

Report acceptance using exactly:

- PASS
- FAIL
- NOT VERIFIED

Missing evidence is NOT VERIFIED, never PASS.

Do not fabricate real-world smoke evidence.

## Definition of Done

A substantial slice is complete only when:

- required behavior is implemented;
- relevant tests pass;
- required real-world/smoke evidence is obtained where needed;
- security/data/identity invariants remain intact;
- unrelated regressions are not introduced;
- a coherent result commit exists;
- final worktree state is reported;
- an Implementation Handoff Report is produced.

Source code merely existing is not completion.

Mock tests merely passing is not completion.

## Commit discipline

Before committing:

- inspect the full diff;
- remove secrets, machine-specific paths, temporary files, and accidental generated artifacts;
- confirm unrelated files were not changed;
- confirm known failures or unverified behavior are explicitly reported.

Do not rewrite unrelated history.

Use a normal feature commit unless the user explicitly requests another Git workflow.

## Handoff discipline

At the end of a substantial task, return an English Implementation Handoff Report containing at least:

- required/verified base commit;
- actual result commit;
- branch/worktree state;
- implemented scope;
- important architectural behavior;
- verification actually executed;
- real-world/smoke evidence;
- acceptance items as PASS / FAIL / NOT VERIFIED;
- remaining debt;
- deferred scope;
- next recommended action.

The Handoff is not a substitute for repository evidence.

## Scope control

Stop and reconsider if work begins to:
- violate an accepted Product Owner decision;
- expand into an unrelated roadmap slice;
- introduce a new source of truth without approval;
- broaden renderer/process privileges unnecessarily;
- depend on ASCII-only path assumptions;
- make another local repository a hidden runtime dependency;
- reopen production GitHub synchronization;
- perform a large unrelated refactor.

Keep the requested slice bounded.

## Current H.5 note

The repository contains unfinished Reviewer integration work originating from the Antigravity attempt.

For Reviewer/H.5 work:
- retrieve the relevant H.5 and Antigravity debt memory records;
- audit the current source before extending it;
- preserve sound salvage;
- do not treat the unfinished implementation as accepted;
- prove the real Reviewer lifecycle rather than relying only on mocked tests.
