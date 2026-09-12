# Repository Core / GitHub Integration Benchmark: Lean-Orchestration Pivot

**Date:** 2026-09-11  
**Repository:** `potoha/MAGINALIA_IDE`  
**Status:** In progress; implementation is substantially present, final acceptance remains open.

## Decision

The Repository Core / GitHub integration benchmark keeps its current product scope and implementation, but changes how Astra is instructed.

The previous benchmark style used a long, self-contained prompt that repeated product philosophy, repository rules, workflow, delegation policy, and acceptance guidance. That was useful while discovering the required control surface, but it now duplicates information already present in `AGENTS.md`, accepted ADRs, planning documents, tests, and dated benchmark reports.

From this point, benchmark runs use **short task prompts plus repository-native instructions**. Implementation and verification are intentionally split into separate runs.

The benchmark now measures not only product correctness, but whether Astra can recover the right working model from the repository with materially lower prompt/context cost.

## Why this pivot

OpenAI's current model guidance says GPT-6 Astra is especially sensitive to instructions in repository files such as `AGENTS.md`, recommends explicitly defining when subagents should be used, and recommends calibrating testing to the size and risk of the change rather than repeatedly running broad suites. OpenAI also recommends evaluating prompt changes empirically rather than assuming a more elaborate prompt is better.

MAGINALIA therefore moves durable knowledge and rules into the repository and keeps the task prompt small.

The new harness is:

`implementation prompt -> AGENTS.md/canonical docs -> Astra/Luna work -> implementation handoff`

then, in a fresh run:

`verification prompt -> AGENTS.md/acceptance criteria -> independent tests/review/live evidence -> PASS | FAIL | INCOMPLETE`

Separating the two runs reduces duplicated context during implementation and gives verification a cleaner stance toward the produced code. The independent-verifier split is a MAGINALIA benchmark design choice; it is compatible with OpenAI's verification guidance but is not presented as an OpenAI-required architecture.

## Current benchmark state captured at pivot

The current implementation/evidence remains authoritative only to the extent supported by code, accepted ADRs, and fresh verification. The existing dated reports show:

- Writing Core baseline verification previously passed, including root checks/build/tests and source/relocated VS Code integration.
- Repository Core defines three local-first storage types: **Project**, **Workbench**, and **Private Shelf**.
- MAGINALIA-created GitHub storage is intended to be private; local writing remains usable without GitHub.
- Portable repository identity, bundled templates, local Git/History, Sync/recovery boundaries, host integration, and a private GitHub adapter have substantial implementation and focused test coverage.
- `RC-02` was accepted after template/identity revisions.
- `RC-03` protocol behavior was accepted, but real-provider behavior remained a separate gate.
- `RC-04` reached completion for its fixture boundary after security repairs; full live-provider acceptance is outside that fixture result.
- `RC-05` host-focused behavior reached 15 focused passing tests in the benchmark report, including offline History and explicit selected-Project handling.
- `RC-06` reviewed live harness/local preflight passed its bounded local checks, but the benchmark report still states that live GitHub execution had not yet occurred.
- Source/relocated runtime integration had passed before final security repairs and therefore still required final artifact/regression confirmation afterward.
- The benchmark report still lists final security delta review, final root/runtime regression under Node 24.18.0, and live-provider create/private verification/upload/restore as open acceptance gates.

Do not infer completion from implementation volume. Re-check current repository state before acting because these are dated benchmark records.

## Prompt policy

Use these two prompts as a pair:

1. `2026-09-11_GPT6_ASTRA_REPOSITORY_CORE_LEAN_PROMPT.md` — implementation-only. It stops at a verifier handoff and does not self-accept the benchmark.
2. `2026-09-11_GPT6_ASTRA_REPOSITORY_CORE_VERIFICATION_PROMPT.md` — fresh independent verification. It returns `PASS`, `FAIL`, or `INCOMPLETE` from current evidence.

Do not copy the old peak-capability prompt into either run. Read `AGENTS.md` first and pull in exact canonical documents only when relevant to the current decision.

## Evaluation

Compare the split lean workflow with the previous benchmark style on:

- correctness / acceptance gates passed,
- regressions introduced,
- unnecessary scope expansion,
- Astra input/context consumption,
- total tokens where observable,
- number and quality of delegated tasks,
- repeated repository reads,
- implementation-to-verification handoff quality,
- verifier independence and defect discovery,
- and meaningful product progress per Astra token.

Lower token use counts as an improvement only if the resulting work still passes the relevant acceptance criteria.
