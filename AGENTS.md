# MAGINALIA_ALPHA — Codex repository instructions

## Purpose

This repository is the active MAGINALIA Desktop implementation target.

Codex may directly inspect, edit, test, run, and commit implementation work when the user gives an explicit work order.

Do not treat historical chat context as product truth when current repository evidence or accepted MAGINALIA_IDE decisions exist.

## Task bootstrap

Before implementation **or review**:

1. Verify the actual Git HEAD and worktree state.
2. If the work order specifies an `expected_base_commit`, require an exact match.
   - If it differs, stop with `STALE_BASE_COMMIT`.
   - Do not silently reset, rebase, or reinterpret the task against another base.
3. Read this file first.
4. Read `memory/README.md` and `memory/index.json`.
5. Retrieve only the memory records relevant to the current task.
6. Inspect the current implementation and tests before making assumptions.
7. Read the relevant canonical planning sources in `MAGINALIA_IDE/plan` before deciding, reviewing, or editing behavior.
8. Follow links from those plan files to accepted ADR / Decision Log entries when they are authoritative for the touched behavior.
9. Explicitly check that the proposed work does not deviate from the relevant current plan.

Do not preload the entire `memory/` directory.

### Canonical-plan gate

`MAGINALIA_IDE/plan` is the current planning source of truth for product scope and behavior.

Implementation and review are not allowed to proceed from prompt wording, memory, or existing code alone when the task touches a planned product concept.

Before changing or approving code, the agent must be able to name the relevant plan file(s) it checked and state why the proposed change is compatible with them.

If the prompt conflicts with the current canonical plan, stop and report the conflict instead of silently choosing one interpretation.

Historical chat context, prior handoffs, repository memory, and existing implementation do not override the current canonical plan.

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

### Salvage and historical sources

Treat older repositories and historical documents as evidence, not active implementation targets. Before reusing material, check the current contract, accepted MAGINALIA_IDE decision, current source, tests, and security boundary. Classify candidate behavior as KEEP, ADAPT, REWRITE, or DROP; preserve contracts and proven behavior while dropping obsolete host glue and credentials. New MAGINALIA Desktop implementation belongs in MAGINALIA_ALPHA unless the Product Owner explicitly directs otherwise.

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

## Command surface principle

Human-facing actions should, by default, have stable namespaced command IDs and be directly executable through the canonical Command Registry/API.

When the same user action is exposed through multiple surfaces, those surfaces should converge on the same command ID and implementation wherever practical. This includes:

- application menus such as File/Edit/View;
- context menus;
- visible buttons, toolbars, and panels;
- Command Palette;
- keyboard shortcuts;
- Mod contributions;
- future authorized automation surfaces.

Do not duplicate feature logic per UI surface. A button, menu item, shortcut, or Mod entry should normally dispatch the same command rather than implement a separate behavior path.

The command boundary represents public user actions, not every internal function. Low-level filesystem validation, database access, IPC, state synchronization, rendering lifecycle, pointer drag state, selection changes, and similar internal transitions remain in their appropriate Controller / Service / IPC / model layers unless there is a concrete user-facing command.

When adding a new Core feature, first decide whether its user-executable actions need stable command IDs. Prefer the default answer to be yes unless the interaction is inherently continuous or state-internal.

## Git/GitHub freeze

Decision D032 remains authoritative.

Do not implement or reopen production Git/GitHub fetch/pull/push/auth/conflict orchestration unless the Product Owner explicitly changes that decision.

D059 removes the frozen remote Git/GitHub product path during pre-installer maintenance. Local Git-backed History remains supported and must be kept separate from remote synchronization.

Local development Git operations required to implement and commit work are allowed.

## Model routing and orchestration

Use the smallest capable model for the job.

### GPT-6 Luna Max — default worker

Use GPT-6 Luna Max for concrete, directly executable work, including:

- implementation;
- bounded bug fixing;
- focused repository inspection;
- ordinary code review;
- test execution and smoke verification;
- small or medium documentation changes;
- narrow investigation whose result can be acted on directly.

Luna Max is the default worker for actual implementation and ordinary investigation.

A task does not require Sol merely because it touches many lines. Escalate when the hard part is judgment, ambiguity, architecture, cross-module ownership, or decomposition.

### GPT-6.1 Sol Mid — decision and decomposition model

Use GPT-6.1 Sol Mid for abstract or high-complexity work, including:

- investigations spanning multiple modules where the root cause or ownership is unclear;
- architecture or source-of-truth decisions;
- large product/state-lifecycle decisions;
- ambiguous failures where several subsystems could be responsible;
- deciding whether existing systems should be unified or kept separate;
- splitting a large task into small independent executable slices;
- work that would otherwise require Luna to invent architecture.

Sol Mid should normally return decisions and bounded executable slices rather than perform a broad implementation itself.

Expected Sol output:

```text
Decision
Root cause
Invariants
Slice 1
Slice 2
...
Verification
```

Each slice must be simple enough for Luna Max to execute without further architectural invention.

If Luna becomes uncertain during a slice, ask Sol. Do not guess.

Older model-routing notes in repository memory are subordinate to this section and the latest explicit Product Owner instruction.

## Scope boundary

The explicit user prompt defines the authorized work boundary.

Do **not** implement, refactor, clean up, migrate, rename, or otherwise change work outside that requested scope merely because adjacent debt is visible.

Allowed outside-scope activity is limited to:

- reading code needed to understand the requested task;
- running verification needed to prove the requested task;
- reporting unrelated defects without fixing them.

If the requested work cannot be completed safely without changing another area, stop and explain the dependency. Do not silently broaden the task.

A Sol decomposition must preserve the same scope boundary. Decomposition is not permission to add adjacent roadmap work.

## Five-hour quota safe-stop and resume

Treat the current rolling 5-hour quota as an execution safety boundary.

When quota telemetry is available:

1. Check the remaining 5-hour quota before starting a substantial slice and again at natural checkpoints.
2. If the remaining quota falls below **15%**, do not start another implementation slice.
3. Finish only the smallest safe atomic operation already in progress if stopping mid-operation would leave the repository inconsistent.
4. Create a resume checkpoint/context that records at minimum:
   - current task and authorized scope;
   - canonical plan files already read;
   - current branch / HEAD / worktree state;
   - files changed;
   - completed slices;
   - tests and evidence already obtained;
   - exact next action;
   - known blockers / uncertainties;
   - any Sol decision that must be preserved.
5. Stop execution after the checkpoint is durable.
6. Read the current 5-hour quota reset time from available quota telemetry. Do not guess it.
7. Create a **one-time** scheduled resume for **one minute after that reset time**.
8. The resume instruction must first reload the checkpoint, re-check Git/worktree state and the relevant canonical plan, then continue only the unfinished authorized scope.

If quota telemetry or scheduling capability is unavailable, do not invent values or claim a resume was scheduled. Stop safely, preserve the checkpoint, and report the missing capability explicitly.

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

## Canonical plan write-back

Completed implementation must be written back to the canonical planning source.

After finishing a substantial task:

1. Re-open the relevant current documents under `MAGINALIA_IDE/plan`.
2. Update the smallest relevant plan entry to reflect the work actually completed.
3. Mark a planned slice or acceptance item **DONE** only when its required acceptance evidence is genuinely satisfied.
4. Record the implementation/result commit and concise evidence when the plan tracks implementation progress that way.
5. If acceptance remains FAIL or NOT VERIFIED, do not mark the work DONE. Record the real status, remaining acceptance requirement, or blocker where the active plan needs that information.
6. If implementation changed user-visible behavior, workflow semantics, state ownership, persistence rules, product terminology, or another planned contract, update the canonical plan text so the specification matches the implemented decision.
7. If the change is an architectural/product decision that belongs in an ADR or Decision Log, update the relevant accepted decision source as well rather than hiding the decision only in implementation notes.
8. Do not rewrite unrelated roadmap items or opportunistically clean up planning documents outside the completed scope.

A code change that intentionally changes planned product behavior is incomplete until the canonical specification records that change.

A completed planned slice is incomplete until the canonical plan records its actual completion state.

If the agent cannot write to `MAGINALIA_IDE`, it must not pretend the write-back occurred. Report the missing access as a blocker and provide the exact plan update required in the handoff.

## Definition of Done

A substantial slice is complete only when:

- required behavior is implemented;
- relevant tests pass;
- required real-world/smoke evidence is obtained where needed;
- security/data/identity invariants remain intact;
- unrelated regressions are not introduced;
- a coherent result commit exists;
- the relevant `MAGINALIA_IDE/plan` status/specification has been written back accurately;
- final worktree state is reported;
- an Implementation Handoff Report is produced.

Source code merely existing is not completion.

Mock tests merely passing is not completion.

A local implementation commit without the required canonical-plan write-back is not completion.

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
- canonical plan files updated, with resulting DONE / pending status and any specification changes recorded;
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

## Current Reviewer boundary

The Python/FastAPI Reviewer sidecar, `sidecars/contracts/`, and the current Reviewer/Shelf approval flow are supported product paths. Preserve the opaque Reviewer `annotationId` QuoteRef identity and prove lifecycle changes through the real sidecar/Electron smoke where applicable. Historical H.5 recovery notes are not current implementation instructions; use the live source, tests, and accepted MAGINALIA_IDE decisions.
