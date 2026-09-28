# MAGINALIA_ALPHA — OpenCode project instructions

## Instant-memory retrieval bootstrap

Do **not** preload the whole `memory/` directory.

At the start of a task:

1. Verify the actual Git base/HEAD.
2. Read `memory/README.md` and `memory/index.json` only.
3. Turn the task into a short retrieval query containing the feature/slice, affected paths, and important constraints.
4. Run:
   ```text
   node memory/query.mjs "<query>"
   ```
5. Load only the highest-scoring memory records needed for the task.
6. Follow any canonical-source pointers in those records when the task depends on current product truth.
7. If an `expected_base_commit` is supplied and differs from the verified base, stop with `STALE_BASE_COMMIT`.

Default memory budget:
- prefer 3–5 records;
- avoid loading unrelated records;
- treat memory as retrieval hints, not authority.

Memory authority is always below:
1. latest explicit Product Owner instruction;
2. accepted MAGINALIA_IDE ADR / Decision Log / active plan;
3. current source, tests, and verified Git state.

## Source of truth

Cross-product architecture and accepted product decisions:
- `potoha/MAGINALIA_IDE`
- especially `plan/09_DECISION_LOG.md`, accepted ADRs, and active plans.

Implementation target for Desktop:
- this repository: `potoha/MAGINALIA_ALPHA`.

Salvage/reference only where explicitly named:
- `potoha/MY_marginallia` for Quote Capture / legacy Reviewer implementation.

Do not reconstruct product truth from old chat summaries when a canonical repository source exists.

## Current execution model

Development execution uses **Chat -> OpenCode Runtime**.

Canonical execution-process sources:
- `MAGINALIA_IDE/plan/05_DEVELOPMENT_CADENCE.md`
- `MAGINALIA_IDE/plan/25_DEVELOPMENT_RUNTIME_HARNESSES.md`

Chat/Product Owner owns product intent, scope, settled decisions, constraints, acceptance, and human UX judgment.
Runtime owns harness selection, decomposition, model routing, retries, verification ordering, quota supervision, checkpoint/handoff, and resume.

Registered roles:
- Harness 00: standard implementation.
- Harness 01: review-only large-scale audit / Installer Readiness.
- Harness 02: installed-build UI/UX improvement.

## Engineering language

Engineering/runtime artifacts are English by default.
Do **not** translate legitimate Japanese product UI, installer text, user-facing messages, fixtures, or content merely to make engineering artifacts English.
Do not impose ASCII-only constraints.

## Core invariants

- Local-first research data.
- Durable user data remains ordinary Markdown/YAML/JSON/images and explicit repository contracts.
- Product boundaries use versioned contracts + adapters.
- Workdesk organizes Projects but does not own child Project contents/history.
- Project, Workdesk, and Private Shelf authorities remain distinct.
- QuoteRef identity remains opaque Reviewer `annotationId`.
- Renderer/presentation changes must not silently mutate Markdown source semantics.
- Normal-user flows must not require Git, Node, Python, PowerShell, PATH editing, npm, pip, or developer setup.

## Git/GitHub freeze

Decision D032 remains authoritative:
production Git/GitHub fetch/pull/push/auth/conflict orchestration is frozen until a human programmer can review that state machine.

Do not reopen production Sync opportunistically.

## Definition of Done

Never call a slice complete because code exists.

A substantial implementation is complete only when required scope is implemented, relevant unit/contract/integration tests pass, required Electron/real-world smoke evidence is collected, acceptance is reported as PASS/FAIL/NOT VERIFIED, the result commit exists, and repository/worktree state is explicitly reported.

Missing evidence is not PASS.

## Handoff discipline

Independent agent/session contexts exchange work through bounded artifacts:
- Development Request Contract,
- exact commit SHA,
- Implementation Handoff Report,
- explicit review/audit artifacts.

Do not rely on hidden conversational continuity.
