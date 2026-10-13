# MAGICAP v3.1 Bundle Contract — Implementation Handoff

## Delivery identity

- Repository: `potoha/MAGINALIA_desktop` (the checkout and origin still use the historical `MAGINALIA_ALPHA` name).
- Required parent branch and PR target: `dev0.2`. The latest Product Owner instruction changes the original PR target from `main` to `dev0.2`.
- Verified parent SHA: `1e0fe37cfdfa4ad369ccff1d4f07f68d5277a86c`. The initial checkout HEAD, fetched parent, and live remote parent matched; the live parent was rechecked before committing. No separate expected SHA was supplied in the request.
- Implementation result SHA: `d34595bcc1a3ccc9e1c24130694ccd2f6b1b4eb9`.
- Work branch: `codex/magicap-v3-1-bundle-contract`, created from the verified parent in an isolated managed worktree.
- This report is delivered in a subsequent documentation commit. The final delivery HEAD is recorded in the PR and delivery response.
- The implementation worktree was clean after the implementation commit. The original checkout's pre-existing untracked attachment directory was untouched.
- Stop boundary: push and open the PR against `dev0.2`; do not merge or deploy.

## Implemented scope and architecture

The outer ZIP is identified by `format: "maginalia-capture-bundle"`, string `version: "3.1"`, and `capbundle:<ULID>` identity. Filenames use `.magicap.bundle`, optionally `.magicap.bundle.zip`, with `application/zip` media type.

The root `manifest.json` indexes independent unchanged v3 ZIPs under `packages/`. Each indexed record includes exact package ID, path, byte size, SHA-256, opaque Capture Book ID, acquisition date, and Capture IDs. One member represents one exact Book/date group; the same Book on different dates uses separate members. Inner source metadata remains authoritative. No Shelf Book identity or Reviewer annotation identity is invented or remapped.

The Bundle profile rejects invalid references, duplicate package/Capture identities or Book/date groups, unsafe or colliding paths, missing or undeclared files, corrupt hashes/CRC, invalid JSON, encrypted/special ZIP members, unsupported child versions, and excessive expansion. Outer and child entry counts and expanded sizes share one budget. The contract also defines byte preservation, validation-before-persistence, coordinated future persistence, and truthful `RECOVERY_REQUIRED` handling without destructive cleanup of existing user data.

The reference verifier is test-only under `sidecars/contracts/test_tools/`. It streams and checks the outer and child archives, then calls existing v3 validation/extraction in temporary staging. It does not initialize a Reviewer database, call persistence/import methods, register commands, or add product import support.

## Changed files

| File or set | Result |
|---|---|
| `docs/magicap-bundle-contract-v3.1.md` | Normative archive/grouping/security/compatibility and failure-protection contract |
| `sidecars/contracts/magicap-bundle-v3.1-manifest.schema.json` | Strict root manifest JSON Schema |
| `sidecars/contracts/README.md` | Contract discovery link and scope boundary |
| `sidecars/contracts/test_tools/magicap_bundle_validator.py` | Contract-only, staged reference verification |
| `sidecars/contracts/test_tools/build_magicap_bundle_fixtures.py` | Deterministic small ZIP fixture generator |
| `sidecars/contracts/fixtures/magicap-bundle-v3.1.*.magicap.bundle` | 26 actual ZIP fixtures: one valid and 25 invalid |
| `sidecars/reviewer/tests/test_magicap_bundle_contract.py` | 34 contract tests and regressions |
| `docs/MAGICAP_V3_1_BUNDLE_IMPLEMENTATION_HANDOFF.md` | This report |

There are 32 implementation files plus this report. Exact paths are available with `git diff --name-only 1e0fe37cfdfa4ad369ccff1d4f07f68d5277a86c HEAD`.

## Verification and acceptance

Executed from `sidecars/reviewer` in the isolated worktree using the existing Reviewer development environment, Python 3.12.11:

```text
python -m pytest -q --basetemp=.pytest-tmp -p no:cacheprovider
```

Result: **112 passed**, including 34 Bundle contract cases and 78 existing Reviewer cases. One existing FastAPI/Starlette test-client deprecation warning remains. Staged and working-tree diff checks passed after final repairs.

The valid fixture contains three opaque Books, four independent v3 ZIPs, and five Captures: an ISBN-backed Book on two acquisition dates, a URL-backed ISBN-free Book, and Handwritten material with hashed canonical JPEG bytes. Tests read real nested ZIPs, verify reference/size/hash consistency and exact image bytes, and reproduce all 26 checked-in fixture byte sequences. Negative cases exercise both ZIP layers and shared aggregate budgets. Final Sol review reproduced and verified repairs for Windows-illegal paths and deep JSON error handling.

| Acceptance item | Status | Evidence or limitation |
|---|---|---|
| Distinct format/version/extension/manifest | PASS | Schema, contract and schema-negative tests |
| Multiple Books and acquisition dates | PASS | Four-child valid ZIP and exact group assertions |
| ISBN-backed, ISBN-free, Handwritten | PASS | Existing-v3-conforming fixtures; ISBN-free fixture is URL-backed |
| Child size/hash/Book/date/Capture consistency | PASS | Positive assertions and negative ZIP fixtures |
| Inner bytes and canonical image integrity | PASS | Fixture composer stores child bytes unchanged; deterministic archive and exact-image checks |
| Duplicate IDs, unsafe paths, bombs, missing files, corrupt hashes | PASS | Concrete invalid ZIPs, bounded shared-budget tests, and outer/inner regression tests |
| Data protection and partial-failure policy defined | PASS | Contract requires complete prevalidation and coordinated persistence/recovery |
| Existing v1/v2/v3 implementation preserved | PASS | Protected-file diff empty; all 78 prior tests pass |
| Final contract review | PASS | `gpt-6.1-sol`, high reasoning; no remaining actionable findings after repairs |
| Production Bundle import, atomic persistence and crash recovery | NOT VERIFIED | Explicitly deferred; no runtime implementation in this PR |
| Capture/WebApp Bundle production and Electron UI/smoke | NOT VERIFIED | Explicitly deferred; no application acceptance claim |

No acceptance item remains FAIL after the repair review. Test and contract PASS do not imply runtime Bundle support.

## Canonical sources and latest Product Owner boundary

Checked relevant planning and accepted decisions:

- `MAGINALIA_IDE/plan/09_DECISION_LOG.md`: D061 and D069.
- `MAGINALIA_IDE/plan/17_CAPTURE_REVIEW_UX_SPEC.md`: explicit read-only snapshot and current standalone picker boundaries.
- `MAGINALIA_IDE/plan/sprints/2026-W35.md`: untrusted handoff and human verification boundaries.
- `MAGINALIA_IDE/docs/magicap-contract-v3.md`.
- ADR 0013 and ADR 0018, plus the relevant Shelf contract identity/provenance context.

These sources preserve versioned contracts, canonical source bytes, opaque identity, and human authority. The latest explicit Product Owner instruction adds only the outer Bundle contract and prohibits v3, Reviewer runtime, Capture, and IDE modifications. It also explicitly overrides the repository's usual canonical-plan write-back requirement for this request: **no IDE plan or decision was edited, marked DONE, or committed**. Future runtime and producer work remains deferred; no canonical plan status was advanced. The pre-existing IDE change to `plan/27_ALPHA_CLOSE_SLICE_SEQUENCE.md` was untouched.

D069/ADR 0018 accepts `bookwithoutisbn` with title and canonical files but no ISBN/URL. Desktop's current v3 schemas still reject that alternative. This is a known alignment gap, not a Bundle-specific redefinition: this PR leaves both existing v3 schemas unchanged, uses an explicit synthetic URL-backed ISBN-free fixture, and makes no locator-free import claim. A later authorized v3 schema/consumer task must resolve that gap without fabricating provenance.

## Models, remaining risks and next action

- Contract design and final/repaired review: `gpt-6.1-sol`, high reasoning.
- Schema, fixtures, verifier, tests and contract document implementation: `gpt-6-luna`, max reasoning.
- The subagent interface exposes priority execution but no separately selectable or verifiable Fast switch; Fast execution is not claimed. The main orchestration session's exact model identifier is not exposed by the available telemetry and is not asserted here.

Remaining risks are the deferred D069 alignment, reliance of this test-only verifier on existing private v3 validation helpers, and unimplemented production staging/transactions/crash recovery and routing. These helpers are repository test reuse, not a new runtime dependency or public import API. The fixed fixtures use synthetic data only. No Capture, IDE or toybox data was written; no production deploy or other PR merge occurred.

Next action: Product Owner reviews this contract PR. After that review, use separate scoped PRs for Reviewer Bundle import and Capture/WebApp generation, with real persistence/recovery and Electron evidence where applicable. Do not implement those paths merely by sequentially calling the existing per-package importer.
