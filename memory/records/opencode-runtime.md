---
id: runtime.opencode
updated: 2026-09-28
status: active
kind: development-runtime
canonical:
  - MAGINALIA_IDE/plan/05_DEVELOPMENT_CADENCE.md
  - MAGINALIA_IDE/plan/25_DEVELOPMENT_RUNTIME_HARNESSES.md
---

# OpenCode runtime context

Development moved from Codex Desktop to OpenCode.

Boundary:

```text
Chat / Product Owner
  -> Development Request Contract
  -> OpenCode Runtime
  -> registered Harness
  -> Git commit + evidence + Implementation Handoff Report
  -> Chat / Product Owner
```

Runtime owns:

- harness selection;
- decomposition;
- model routing;
- retries/escalation;
- verification order;
- progress telemetry;
- human STOP;
- quota supervision;
- checkpoint/handoff;
- persistent resume.

Harnesses:

- Harness 00: standard implementation;
- Harness 01: non-implementation large-scale audit / Installer Readiness;
- Harness 02: installed-build UI/UX improvement.

Acceptance values:
- PASS
- FAIL
- NOT VERIFIED

Missing evidence is not PASS.

Engineering artifacts are English by default.
Japanese product/installer/user-facing text remains Japanese where required.

Operational model-routing preference may change without product-plan edits. Current direction favors a cost-efficient Terra-class lead for ordinary orchestration, GPT-6 Luna Max for implementation, and heavier Sol-class reasoning for difficult escalation/architecture review.
