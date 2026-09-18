# Repository Core freeze — Before Kaldi

## Freeze status

2026-09-18: cloud development is **FROZEN / DEFERRED / EXPERIMENTAL**. Do not complete or expose provisioning, Sync, Restore, recovery, or cloud UI as part of this freeze. The existing Electron cloud code and tests remain in place. `D:\python\MAGINALIA_IDE` is a read-only historical reference; do not port its cloud state machine.

## Stable local baseline

- Exactly three kinds: Project, Workbench, Private Shelf; portable `.maginalia/repository.json` identity; local creation and open.
- Project/Workbench use the Document and Writing Core flow; Private Shelf uses the Library flow.
- Local History, fresh-copy History viewing, incomplete marker, and opaque-ID/path boundaries.
- Local-first operation; **Save != Sync**.

## Deferred cloud scope and current Electron assets

| Asset | Freeze assessment |
| --- | --- |
| Device Flow auth and private-work discovery | Implemented components; discovery IPC/preload exists, but no normal renderer UI route. Live GitHub acceptance not established. |
| Pending ledger and private provisioning coordinator | Implemented components and tests; not product-wired. |
| GitHub adapter and Sync relationship classification | Implemented components and tests; no product Sync route. |
| Renderer transient cloud state controller | Implemented, but not instantiated by the normal renderer UI. |
| Main-process cloud coordinator | Partial: discovery ownership/cancellation/catalog only, not one complete provision/Sync/Restore coordinator. |
| Windows Job Object utility-process worker | Experimental launch/limit/timeout harness with tests; worker handles noop/test operations, **not remote Git materialization**. |

Normal UI has no cloud action to disable. Setup Private Cloud Storage, Sync, and selected Restore are not product-reachable. Discovery IPC/preload remains registered for experimental code/tests, so do not mistake UI unreachability for complete cloud security or readiness.

## Known risks and invariants

- Legacy VS Code code has known duplicate-create, malformed-pending re-create, and repeated-Sync recovery-copy multiplication risks. Record only; do not modify or port it.
- Electron pending protection exists, but end-to-end cloud orchestration/product routes are incomplete. Remote fetch/pack processing is not yet inside the isolated worker; repeated recovery deduplication and selected Restore are not established product behavior. Keep the product gate closed.
- On restart preserve: local-first, Save != Sync, private-only cloud storage, non-persistent tokens, no force push, **one identity = one unresolved cloud intent**, and **same divergence = same recovery**. Never overwrite the active worktree for Restore/recovery.

## Exact restart point and order

1. Read `docs/REPOSITORY_CORE_FREEZE.md` and `readme-first.md`; inspect current Git status without discarding uncommitted work.
2. Verify current tests and local baseline.
3. Establish one Electron main-process cloud coordinator for all product operations; reuse the partial discovery coordinator rather than creating another state machine.
4. Preserve pending-ledger idempotency.
5. Fail closed on malformed pending.
6. Deduplicate recovery copies by portable identity, local head, and remote head.
7. Complete Sync product wiring.
8. Complete isolated fresh-copy Restore/recovery materialization, including remote Git processing inside the worker and incomplete-marker validation.
9. Only then perform live GitHub acceptance.

## Verification baseline at freeze

- `npm run typecheck` PASS (rerun serially; an initial parallel run raced `npm test` over generated Format schemas).
- `npm test` PASS: Format 14, Repository Core 8, Writing Core 13, desktop 445; desktop 1 skipped.
- `npm run build` PASS; existing Monaco bundle-size warning remains.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- `npm run smoke` and existing `smoke:writing`, `smoke:workspace`, `smoke:quotation`, `smoke:repository`, `smoke:worker-job` PASS. Markers: `MAGINALIA_ELECTRON_SMOKE_OK`, `MAGINALIA_ELECTRON_WRITING_SMOKE_OK`, `MAGINALIA_ELECTRON_WORKSPACE_SMOKE_OK`, `MAGINALIA_ELECTRON_QUOTATION_SMOKE_OK`, `MAGINALIA_ELECTRON_REPOSITORY_SMOKE_OK`, `MAGINALIA_WORKER_JOB_SMOKE_OK`.
- No cloud smoke or live GitHub acceptance was performed. Native dialog/IME manual acceptance was not rechecked for this freeze.

The freeze preserves pre-existing uncommitted cloud work in `apps/desktop`, `package-lock.json`, and `docs/decisions/0003-private-cloud-boundaries.md`; no commit/reset/clean was performed. Recheck `git status` at restart. Build output is generated/ignored, not a new handoff artifact.
