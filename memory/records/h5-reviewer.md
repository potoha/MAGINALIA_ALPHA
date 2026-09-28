---
id: active.h5-reviewer
updated: 2026-09-28
status: active
kind: active-slice
canonical_context:
  - MAGINALIA Quote Capture Reviewer implementation
  - current MAGINALIA_ALPHA source/tests
---

# H.5 Reviewer integration

Decision: retain the existing Python/FastAPI Reviewer. Do not rewrite its backend into TypeScript.

Target:

```text
MAGINALIA Desktop
  -> ReviewerProcessManager
  -> Python/FastAPI Reviewer sidecar
  -> 127.0.0.1:<managed port>
  -> central registered Reviewer View
```

Reviewer remains responsible for:

- SQLite workspace;
- `.magicap` importer;
- ZIP/security validation;
- review state;
- OCR orchestration;
- Pillow selected-region crop;
- NDLOCR-Lite subprocess integration;
- approved quote search;
- Reviewer Web UI.

Desktop owns:

- sidecar start/restart/shutdown;
- managed loopback port;
- service + contract-version readiness;
- persistent workspace location;
- safe single-instance central Reviewer View;
- crash/unavailable isolation;
- existing Shelf/search/resolution adapter connection;
- Shelf refresh after approval.

Normal users must not manually start Reviewer or install Python/uv.

Completion flow:

```text
open MAGINALIA
-> open Shelf Review
-> sidecar auto-starts
-> import .magicap
-> OCR/review/correct
-> approve
-> return to Shelf
-> approved quote is searchable
-> insert QuoteRef
-> close MAGINALIA
-> no orphan sidecar
```

Before continuing H.5, retrieve `debt.antigravity-h5`.
