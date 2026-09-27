# MAGINALIA_ALPHA — OpenCode project instructions

## Session bootstrap

Before planning, editing, reviewing, or running tests:

1. Read `memory/INSTANT_MEMORY.md`.
2. If the task touches Reviewer H.5 recovery, also read `memory/ANTIGRAVITY_DEBT.md`.
3. Verify the actual Git base/HEAD. Never assume the commit recorded in memory is still current.
4. Read only the canonical MAGINALIA_IDE plans/ADRs needed for the requested scope.

The `memory/` files are an **instant-memory bootstrap**, not product specification.
When memory conflicts with repository truth, accepted ADRs, current tests, or the user's latest explicit decision, repository/user truth wins.

## Source of truth

Cross-product architecture and accepted product decisions:
- `potoha/MAGINALIA_IDE`
- especially `plan/09_DECISION_LOG.md`, accepted ADRs, and active plans.

Implementation target for Desktop:
- this repository: `potoha/MAGINALIA_ALPHA`.

Salvage/reference only where explicitly named:
- `potoha/MY_marginallia` for Quote Capture / legacy Reviewer implementation.

Do not make product decisions from historical chat notes when a canonical repository decision exists.

## Current execution model

Development execution has moved from Codex Desktop work packets to **Chat -> OpenCode Runtime**.

Use the Development Request Contract and Runtime/Harness model defined by:
- `MAGINALIA_IDE/plan/05_DEVELOPMENT_CADENCE.md`
- `MAGINALIA_IDE/plan/25_DEVELOPMENT_RUNTIME_HARNESSES.md`.

Runtime owns decomposition, model routing, retries, verification ordering, quota supervision, checkpoint/handoff, and resume.
Normal product requests should not hard-code harness internals unless debugging the Runtime itself.

Registered roles:
- Harness 00: standard implementation.
- Harness 01: review-only large-scale audit / Installer Readiness.
- Harness 02: installed-build UI/UX improvement.

If an `expected_base_commit` is supplied and does not equal the verified base, stop with `STALE_BASE_COMMIT`. Never silently substitute another HEAD.

## Engineering language

Engineering/runtime artifacts are English by default:
- prompts,
- agent instructions,
- plans/reports/handoffs,
- structured runtime events,
- code comments and commit messages where appropriate.

Do **not** translate legitimate Japanese product UI, installer text, user-facing messages, test fixtures, or content merely to make engineering artifacts English.
Do not impose ASCII-only constraints.

## Core invariants

- Local-first research data.
- Durable user data remains ordinary Markdown/YAML/JSON/images and explicit repository contracts.
- Product boundaries use versioned contracts + adapters; do not couple products through internal module imports.
- Workdesk organizes Projects but does not own child Project contents/history.
- Project, Workdesk, and Private Shelf authorities remain distinct.
- QuoteRef identity remains opaque Reviewer `annotationId`.
- Renderer/presentation changes must not silently mutate Markdown source semantics.
- Normal-user flows must not require Git, Node, Python, PowerShell, PATH editing, npm, pip, or developer setup.

## Git/GitHub freeze

Decision D032 remains authoritative:
production Git/GitHub fetch/pull/push/auth/conflict orchestration is frozen until a human programmer can review that state machine.

Do not reopen production Sync opportunistically.
Local History/interfaces/design work are not permission to ship production remote Git state transitions.

## Definition of Done

Never call a slice complete because code exists.

A substantial implementation is complete only when the required scope is implemented, relevant unit/contract/integration tests pass, required Electron/real-world smoke evidence is collected, acceptance is reported as PASS/FAIL/NOT VERIFIED, the result commit exists, and repository/worktree state is explicitly reported.

Do not convert missing evidence into PASS.

## Handoff discipline

Independent agent/session contexts exchange work through bounded artifacts:
- Development Request Contract,
- exact commit SHA,
- Implementation Handoff Report,
- explicit review/audit artifacts.

Do not rely on hidden conversational continuity.

At a pause or end, report:
- base commit,
- result commit if any,
- implemented scope,
- verification,
- acceptance status,
- known debt/watch items,
- next action,
- resume state if applicable.

## Current hazard

The current main branch may still contain the unfinished Antigravity Reviewer integration commit.
Do not treat that commit as completed H.5.
Read `memory/ANTIGRAVITY_DEBT.md` before continuing Reviewer integration.
