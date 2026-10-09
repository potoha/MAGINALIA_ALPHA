# Development Request: PR #27 Installer Remediation and Version 0.1.0

## Objective

Make the smallest safe correction to the existing MAGINALIA Desktop Windows distribution pull request before merge.

**Product Owner decision:** The application/package/release version is **`0.1.0`**. Keep the human-facing brand **`MAGINALIA desktop α1`** and the supplied artwork unchanged. The Product Owner delegates ordinary implementation decisions for the other two review findings to engineering, subject to the safety requirements below.

**Target:** `potoha/MAGINALIA_ALPHA` PR #27, `codex/windows-installer-first-run`  
**Last verified PR head:** `539b4ad578dae84a069b377a777e017fccdac3cf`  
**PR:** https://github.com/potoha/MAGINALIA_ALPHA/pull/27

This is a targeted fix, **not** a new installer feature or a release approval.

## Bootstrap and authority

1. Follow repository `AGENTS.md`; inspect actual branch/HEAD, worktree, memory index and only relevant records.
2. Require the PR worktree to be at the expected head above. If it differs, **STOP `STALE_BASE_COMMIT`** and report actual state. Do not reset/rebase/merge silently.
3. Consult relevant canonical `MAGINALIA_IDE` decisions and plans, especially D023, D043, D063, D066, D068, `plan/22_WORKDESK_BROWSER_INSTALLER.md`, `plan/27_ALPHA_CLOSE_SLICE_SEQUENCE.md`, and ADR 0017.
4. Preserve the accepted separation of application data, research files, and Installer acceptance. Do not change product identity, the existing userData directory, `.magi` contracts, or Shelf format versions.

## Fix 1: Version 0.1.0 (required)

- Set `apps/desktop/package.json` package version to exactly **`0.1.0`**.
- Update the corresponding workspace lockfile metadata and all build/staging inputs that propagate application version into the packaged EXE and Windows Programs/Uninstall display.
- Verify that electron-builder/NSIS packaged application metadata and future upgrade detection consistently use version `0.1.0`.
- Preserve stable `appId`, product display name **`MAGINALIA desktop α1`**, internal package name `@maginalia/desktop`, splash/branding assets, profile path, and per-user install defaults.
- Prefer a version-distinguishable installer filename such as `MAGINALIA-desktop-0.1.0-Setup.exe` if compatible with the current distribution scripts, and update paths/tests/reporting accordingly. Do not publish the artifact.
- Do **not** change `@maginalia/format` schema or Shelf records from `0.1` to `0.1.0`: the application release version and portable data-format version are distinct.

## Fix 2: Respect an existing Private Shelf's `library.json` (required, P1)

**Observed:** `apps/desktop/src/first-run-setup.ts`, inside `createPrivateShelfForSetup`, rejects an existing `library.json` whenever its raw bytes differ from the tutorial seed's own `library.json`. This can block a completely valid existing Shelf with a different name or formatting, despite `materializeTutorialShelfSeed` supporting existing libraries.

**Required behavior:**

- For a genuinely new empty Shelf only, initialize `library.json` using the supported contract.
- For an existing valid Shelf, validate its own `library.json`, preserve its bytes, location paths, marker and user records, and merge tutorial Books/Annotations using the existing **add-only, idempotent, conflict-reporting** materializer.
- The existing Shelf may use a different `name`, JSON whitespace/order, and valid `booksPath` / `annotationsPath` values. These are not grounds to replace or reject the library.
- Reject unsafe/invalid configurations explicitly, without overwriting data. Preserve the current rules for explicit adoption of a missing `.magi` marker and never silently regenerate an identity.
- Avoid hidden changes to existing Shelf format v0.1 and the deferred v0.4 migration.
- Add a **coordinator-level regression test** that selects an existing valid populated Private Shelf with a library different from the bundled sample, completes first-run onboarding, preserves the exact original `library.json` and user-record bytes, imports only missing seed items, and finishes/resumes without duplication.
- Include repeat-run and same-ID/different-content conflict scenarios where feasible. Distinguish tests that call `materializeTutorialShelfSeed` directly from tests covering the actual user-facing coordinator route.

## Fix 3: Safe Desktop shortcut uninstall (required, P2)

**Observed:** `apps/desktop/packaging/installer-shortcut.nsh` uses a marker in the install directory to delete the Desktop shortcut by **name** on uninstall. If the user replaces that `.lnk` after installation, uninstall may delete their replacement.

**Required behavior:**

- Only remove a Desktop shortcut when it can be reliably established to be **the one the MAGINALIA installer owns and has not been replaced**.
- An install-directory marker and matching filename alone are insufficient proof.
- Preserve the existing UX: Start Menu entry default, optional Desktop shortcut unchecked by default, and non-destructive conflict behavior when a same-name shortcut already exists.
- Prefer the simplest reliable mechanism supported by the actual NSIS/electron-builder configuration. If ownership cannot be reliably verified at uninstall time, **preserve the ambiguous shortcut rather than deleting a possibly user-authored replacement**, and document the residual cleanup behavior.
- Cover fresh install, upgrade/reinstall, same-name existing shortcut, user-replaced shortcut, and uninstall via automated or real-machine evidence as appropriate. Do not claim a real installer PASS from source inspection alone.

## Required verification

Run and report actual results for:

1. Focused first-run coordinator, Shelf seed and setup tests (including the new existing-Shelf route).
2. Full `npm test`, typecheck and build.
3. Windows packaging artifact generation and package metadata verification (`0.1.0`, `appId`, display name, executable/version info where inspectable).
4. Packaged Electron first-run, restore, Shelf, quotation, and export smokes when available.
5. `git diff --check`.
6. Optional shortcut handling with realistic disposable Windows desktop paths/accounts; **NOT VERIFIED** if no installed-product test was run.

Keep work against disposable test data; never touch the owner's real Workdesk, Projects, Shelf or research files.

**Explicitly preserve the existing acceptance gap:** double-click installation, Start Menu/Desktop integration, update/reinstall, uninstall data preservation, interrupted setup on an installed machine, and clean Windows user acceptance are NOT VERIFIED until run on a disposable actual Windows installation.

## Boundaries and delivery

- Keep changes local to this PR and its necessary tests/metadata.
- Do not change installer framework, rework UI branding, implement the rest of D043, revive GitHub sync, refactor unrelated systems, or alter licensing.
- Do not author the user manual. ChatGPT and the Product Owner will prepare the separate Japanese `マニュアル.pdf` using YOMIYASU; packaging location remains `apps/desktop/packaging/manual/マニュアル.pdf`. README is not the manual.
- Preserve the previous installer development report and the canonical plan status; do not mark I2 as DONE.
- Commit locally in the existing PR branch. **Do not push, merge, release, or create a PR** without explicit Product Owner authorization.
- Provide an English Implementation Handoff Report: base/result SHAs, branch/worktree, exact files changed, three fixes, installer version evidence, tests with `PASS / FAIL / NOT VERIFIED`, remaining installed-product gates, and whether the existing PR is ready for push and review.

**Success:** Release version is `0.1.0`, an existing valid Private Shelf works through the real onboarding path without being replaced, and uninstall cannot accidentally delete an ambiguously owned Desktop shortcut. The installed-product/release acceptance remains a separate human gate.
