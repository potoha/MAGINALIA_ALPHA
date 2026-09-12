# Repository Core Independent Verification Result: FAIL on HEAD atomicity

**Date:** 2026-09-11  
**Disposition:** FAIL  
**Scope:** Independent verification of the latest Repository Core lock-delta implementation.

## Summary

The independent verification run rejected the current implementation before live GitHub mutation.

The implementation had moved snapshot locking to cover the initial repository read through final capture and had added a queued History regression. Focused tests, root verification, source/relocated runtime integration, and local three-type preflight passed. However, a focused security review found that publishing the Git HEAD ref still uses a direct file write.

A disposable local fixture reproduced a failure mode where an injected `ENOSPC` after truncating `.git/refs/heads/main` leaves the ref empty. The snapshot recovery journal is then removed, and History cannot reopen the repository state. Authored `manuscript.md` bytes remain intact.

Because this is a recoverability defect in the local repository core, the verifier stopped before the authorized live GitHub fixture run.

## Evidence from verification run

- Changed-surface focused suite: 24 passed, 1 skipped due to Windows file-symlink privilege restrictions.
- Concurrent History and interruption-recovery cases passed.
- Node 24.18.0 root verification: 162 passed, 1 skipped.
- Source and relocated VS Code integration passed.
- Local no-auth/no-network preflight for Project, Workbench, and Private Shelf plus quotation insertion passed.
- Additional security inspection identified direct HEAD-file publication.
- Failure injection against a disposable local fixture reproduced:
  - HEAD ref truncated to zero bytes,
  - snapshot journal absent after the failure,
  - History failing to open,
  - authored manuscript bytes preserved.
- No live GitHub mutation was performed.

## Blocking defect

HEAD publication is not sufficiently atomic/recoverable across a write failure whose outcome is uncertain.

The implementation must not delete recovery evidence when the HEAD update may have partially modified the ref. A failure after truncation but before durable completion must leave enough information to recover or reject safely.

## Minimum implementation response

1. Publish HEAD atomically rather than by direct in-place truncating write.
2. Preserve the recovery journal when HEAD publication outcome is unknown or partially completed.
3. Add the reproduced truncation/write-failure case as a regression test.
4. Return to a fresh independent verification run. Do not proceed to live GitHub acceptance until the local recoverability gate passes.

## Still unverified

- Real Windows file-symlink behavior where privilege was unavailable.
- Final security acceptance after the repair.
- Live GitHub create/private-verification/sync/restore.

This document is dated benchmark evidence, not a standing product requirement. Accepted ADRs and current repository guidance remain authoritative.
