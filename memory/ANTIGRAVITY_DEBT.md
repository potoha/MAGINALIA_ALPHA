# Antigravity Reviewer Integration Debt

**Recorded:** 2026-09-27  
**Source commit:** `6e5514592544416ec4b9c2d6bb88bf92491b7519`  
**Commit message:** `reviewer 実装 進行中`  
**Status:** unfinished H.5 work; salvage selectively, do not treat as accepted implementation.

This debt record exists so a new OpenCode session does not repeat the earlier mistake of equating generated components with an integrated product flow.

---

## 1. Recovery verdict

Do **not** blindly revert the repository to Slice H.

There is useful work in the Antigravity commit:

- Python Reviewer source was salvaged into `sidecars/reviewer/`;
- most existing Reviewer implementation remained unchanged;
- a small service identity/health endpoint was added;
- a `ReviewerProcessManager` abstraction was started;
- unit-test scaffolding exists.

However, the commit is not an acceptable H.5 result.

Recommended strategy:

**keep salvage -> repair foundation -> prove real sidecar -> continue integration.**

Do not layer more UI/integration code on top of the current ProcessManager without first addressing the findings below.

---

## 2. Critical concrete debt

### A. Developer-machine absolute NDLOCR path was committed

File:

`sidecars/reviewer/ndlocr.json`

It contains a command path pointing into a local checkout such as:

`D:\\python\\MY_marginallia\\APK\\reviewer\\OCRengine\\...`

Why this is wrong:

- violates the no-sibling-repository runtime-dependency goal;
- is machine-specific;
- is unusable for other developers and Installer packaging;
- leaks local filesystem layout into repository configuration.

Recovery:

- do not keep a real machine-specific `ndlocr.json` as canonical tracked runtime config;
- retain authoritative NDLOCR version/hash lock data;
- use an example/template or generated/app-owned runtime config;
- Installer/runtime must resolve its own bundled executable later.

Severity: **critical before H.5 acceptance**.

---

### B. ReviewerProcessManager is not integrated into the production Desktop build/path

Created:

`apps/desktop/src/reviewer-process-manager.ts`

At the recorded HEAD, it was not wired into the normal main-process integration path and was not listed in the explicit `apps/desktop/tsconfig.main.json` main-source include.

Consequences:

- fake/unit tests may pass while production code never compiles/executes this path;
- existing Shelf adapters still do not obtain their base URL from the manager;
- writing the class is not equivalent to integrating Reviewer.

Recovery:

- repair first;
- explicitly include/build it through the normal main process;
- instantiate/own it from Desktop main lifecycle;
- connect existing Reviewer search/resolution adapters to `ensureReady()`/managed base URL;
- verify through a real Electron/sidecar smoke.

---

### C. Contract version is declared but not actually enforced

The manager defines an expected contract version, but readiness acceptance was observed checking the service identity without requiring the expected `contractVersion` value.

Risk:

an incompatible Reviewer version can be accepted as ready.

Recovery:

require both:

```text
service == expected service
contractVersion == expected version
```

Reject missing/unknown/incompatible versions.

---

### D. Windows termination path is not genuinely graceful

Observed manager behavior:

- attempt `SIGTERM`;
- on Windows, immediately launch `taskkill /T /F`;
- then wait.

This defeats the intended policy:

```text
graceful request
-> bounded wait
-> force only if still alive
```

Recovery:

- define/test an actual graceful shutdown phase;
- wait bounded time;
- only then use forceful process-tree termination;
- prove app quit leaves no orphan sidecar.

Do not report "graceful shutdown" while immediately forcing termination.

---

### E. Sidecar root discovery is brittle

The development launch strategy tries to derive `sidecars/reviewer` from compiled `__dirname` and then falls back to `process.cwd()`.

This must be proven against the actual build/start/package layouts.

Risk:

- source-tree tests work;
- built Electron cannot find the sidecar;
- future packaged app path differs again.

Recovery:

- make development and packaged launch resolution explicit strategies;
- add tests for actual compiled layout;
- run a real built Desktop -> Python Reviewer start smoke;
- leave a clean interface for Installer-owned executable/runtime resolution.

---

### F. Contract files have duplicate ownership

The Antigravity commit introduced both:

- `sidecars/contracts/`
- `sidecars/reviewer/contracts/`

with apparently duplicated schemas/fixtures.

Risk:

- unclear authority;
- silent drift between copies;
- packaging ambiguity.

Recovery:

- choose one canonical contract location;
- make Reviewer resolve that location explicitly;
- if a packaged copy is required, generate/copy it as a build artifact rather than maintaining two editable authorities.

Do not preserve duplication merely because current path probing can find either copy.

---

## 3. Major missing H.5 integration

The WIP commit did not complete the product slice.

Still required:

- main-process ownership of ReviewerProcessManager;
- managed Reviewer URL feeding existing `reviewer-ipc.ts` / `reviewer-resolution.ts`;
- registered central single-instance Reviewer View;
- safe Electron remote-content/navigation boundary;
- command and Shelf entry action to open Reviewer;
- `.magicap` import through existing Reviewer UI/API;
- review/approval flow inside central View;
- approved quote visible in Shelf without Desktop restart;
- Reviewer restart recovery;
- Reviewer unavailable UX that does not break Workdesk/Project/Editor;
- app shutdown lifecycle;
- real sidecar smoke;
- relevant regression suite;
- Installer handoff contract.

Therefore `6e551459...` must never be used as evidence that H.5 is complete.

---

## 4. Test-quality debt

The ProcessManager tests created in the WIP commit are useful scaffolding, but they mainly use fake child processes/fake HTTP responses.

That does not prove:

- the salvaged Python package starts from the built Desktop path;
- the selected port and CLI args work;
- service/version readiness works against real FastAPI;
- workspace persistence survives restart;
- shutdown leaves no orphan process;
- `.magicap` import works through the integrated path;
- Shelf sees a newly approved record;
- Electron central View loads safely.

Recovery order should include a **real local Python sidecar integration test/smoke early**, before building more UI on top.

Keep mock tests for fast failure-path coverage, but do not let them substitute for integration evidence.

---

## 5. Salvage that should normally be preserved

Unless current code inspection finds a regression, preserve rather than rewrite:

- salvaged FastAPI Reviewer backend;
- SQLite Workspace;
- `.magicap` importer and validation;
- OCR adapter/orchestration;
- Reviewer Web UI;
- existing Reviewer tests;
- service identity/health concept;
- launch strategy interface;
- workspace-locator interface;
- bounded diagnostic-log idea;
- concurrent-start deduplication idea;
- loopback managed-port direction.

The failure was primarily incomplete/brittle integration, not proof that the underlying Python Reviewer should be discarded.

---

## 6. Do not reintroduce old scope

While recovering H.5, do not:

- rewrite FastAPI/SQLite Reviewer into TypeScript;
- add a new database;
- create a new OCR engine;
- implement general Browser/Web View;
- implement Installer;
- reopen production Git/GitHub Sync;
- mix H.6/H.7 authoring changes into Reviewer recovery;
- require normal users to install Python/uv manually.

Keep the recovery bounded.

---

## 7. Suggested first OpenCode recovery sequence

Use Harness 00 against the exact verified HEAD.

Suggested phases:

1. **Inventory**
   - compare salvaged Python Reviewer against its source/reference;
   - identify intentional changes only;
   - verify current build inclusions and lifecycle wiring.

2. **Remove unsafe artifacts**
   - eliminate machine-specific NDLOCR config;
   - resolve contract ownership duplication.

3. **Repair ProcessManager**
   - contract-version validation;
   - correct development/package path abstraction;
   - actual graceful/force shutdown phases;
   - tests.

4. **Prove real sidecar**
   - launch salvaged FastAPI Reviewer;
   - managed port;
   - readiness;
   - persistent workspace;
   - shutdown/restart;
   - no orphan.

5. **Integrate existing Desktop adapters**
   - search;
   - resolution;
   - publication lookup;
   - unavailable isolation.

6. **Central Reviewer View**
   - registered single-instance;
   - no DocumentSession semantics;
   - same-origin Reviewer navigation only;
   - no general browser feature.

7. **End-to-end Shelf intake**
   - fixture import;
   - review/approve;
   - Shelf refresh;
   - QuoteRef;
   - regression/smoke.

8. **Commit + Implementation Handoff Report**
   - acceptance items PASS/FAIL/NOT VERIFIED;
   - explicit Installer handoff.

---

## 8. Completion rule

H.5 is not complete until the user can conceptually follow:

```text
open MAGINALIA
-> open Shelf Review
-> sidecar starts automatically
-> import .magicap
-> review / OCR / correct
-> approve
-> return to Shelf
-> quote is searchable
-> insert QuoteRef
-> close MAGINALIA
-> no orphan sidecar
```

with required tests/smokes and no developer-only setup in the normal product path.
