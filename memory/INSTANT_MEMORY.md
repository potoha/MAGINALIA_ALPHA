# MAGINALIA Instant Memory

**Updated:** 2026-09-27  
**Purpose:** fast OpenCode session bootstrap.  
**Scope:** current repository state, durable architecture context, active work, and near-term roadmap.

This file is intentionally concise. It is not a replacement for MAGINALIA_IDE plans/ADRs or current source/tests.

---

## 1. Read order

At session start:

1. Read this file.
2. Verify actual Git HEAD.
3. Read only the relevant canonical files in `potoha/MAGINALIA_IDE`.
4. For Reviewer H.5 work, read `memory/ANTIGRAVITY_DEBT.md`.
5. Inspect current implementation/tests before assuming memory is current.

Authority order:

1. latest explicit Product Owner instruction;
2. accepted MAGINALIA_IDE ADR / Decision Log / active plan;
3. current implementation + tests;
4. this instant memory;
5. historical chat/context.

---

## 2. Repository state at handoff

Repository: `potoha/MAGINALIA_ALPHA`

Verified `main` HEAD when this memory was created:

`6e5514592544416ec4b9c2d6bb88bf92491b7519`

Commit message:

`reviewer 実装 進行中`

This is **not a completed H.5 commit**.

The last accepted completed product slice before that unfinished work is:

`ae03e63cad6a6f171b134c26b02743aff1f13f33` — Slice H: Workdesk.

Do not reset the repository blindly to `ae03e63`: later documentation/license/handoff commits are legitimate, and parts of the Reviewer salvage are reusable. Recover H.5 selectively.

---

## 3. Completed Desktop foundation

Important completed slices and known commits:

- B.2 Registry Explorer: `2807061bece0037cedcc40ff172ba913f4ddbe76`
- C Shelf + QuoteRef: `d5d79b8a6c9beb9b84d97bc07562181011df3698`
- D Generic Source + Automatic References: `85691b660993a826ef5994486219f77408a99138`
- D.5 multi-document tabs + Mod host: `37add8ce748138f3128ce4143521f0d22210c85e`
- E resolved Markdown Export: `6caff6ac280302e9a344f6c7a64c1ef22db5a46`
- P0+1 Autosave: `095c95f4b95fe4f3826dabd12a47166c7cf4ba4f`
- F Rich Renderer / vertical preview / media: `b6c398c9e03f4edc8caeaf7ed1f0eb019605fb4e`
- G Command Registry / Palette / Unified Search: `0cc0bbd6259693643cc87abd0f6929f01fa5c490`
- H Workdesk: `ae03e63cad6a6f171b134c26b02743aff1f13f33`

Some older A/B commits are not repeated here. Read Git history if exact provenance is required.

### Current product capabilities already expected to remain working

- independent Electron + Monaco Desktop;
- Project/Workdesk/local repository flows;
- Workdesk parent with independent child Projects;
- DocumentSession + tabs;
- mandatory ~1s Autosave;
- Edit/Preview Renderer;
- horizontal/vertical preview;
- safe local media import and image optimization;
- Wiki/internal links;
- Command Registry, Palette, Toolbar/Context contributions;
- Unified Search with Shelf vs Project semantics kept distinct;
- Reviewer-backed approved quotation search;
- QuoteRef insertion using opaque Reviewer `annotationId`;
- automatic reference resolution;
- resolved Markdown export;
- Mod host.

Regressions in these surfaces are not acceptable collateral damage for later slices.

---

## 4. Current active recovery: H.5 Reviewer integration

Product decision: **keep the existing Python/FastAPI Reviewer**.

Do not rewrite Reviewer backend to TypeScript.

Target architecture:

```text
MAGINALIA Desktop
  -> ReviewerProcessManager / managed sidecar
  -> Python/FastAPI Reviewer
  -> 127.0.0.1:<managed port>
  -> registered central Reviewer View
```

Reviewer keeps responsibility for:

- SQLite workspace;
- `.magicap` importer;
- ZIP/security validation;
- review state machine;
- OCR orchestration;
- Pillow selected-region crop;
- NDLOCR-Lite subprocess integration;
- approved quote search;
- Reviewer Web UI.

Desktop owns:

- sidecar start/restart/shutdown;
- managed loopback port;
- readiness/service-version validation;
- persistent workspace location;
- safe central single-instance Reviewer View;
- crash/unavailable isolation;
- connection of existing Shelf/search/resolution adapters to the managed Reviewer;
- Shelf refresh after approval.

No user should have to start Reviewer manually.

Final installer must bundle/manage Reviewer runtime and NDLOCR dependencies without asking normal users to install Python, uv, Node, or edit PATH.

### H.5 current status

Antigravity began H.5 and pushed unfinished work in `6e551459...`.

Useful salvage exists, but it must be audited/repaired before further integration.
See `memory/ANTIGRAVITY_DEBT.md`.

Recommended next implementation action:

**Harness 00 recovery on exact current HEAD**, first repairing/verifying the sidecar foundation with a real Python-sidecar integration smoke, then continuing main-process adapter + central View + Shelf refresh work.

Do not call H.5 complete until real sidecar lifecycle, import/review/approval, Shelf visibility, shutdown, and required regressions are verified.

---

## 5. H.6 Product Owner decisions not yet assumed implemented

H.6 is a small Renderer/editor quality slice after H.5.

Decisions from Product Owner discussion:

1. Vertical writing must become practical for writing/editing, not only a read-only vertical preview.
2. Heading/outline hierarchy must render clearly and update live.
3. Figures/images/tables must live-render correctly during authoring.
4. Normal Japanese prose paragraphs default to a one-character first-line indent.
   - presentation rule only;
   - do not insert full-width spaces into Markdown source;
   - apply to ordinary prose paragraphs;
   - do not blindly indent headings, lists, blockquotes, code, tables, media captions, etc.;
   - horizontal and vertical presentation share the same semantic rule.

Before implementation, inspect current Monaco/Preview constraints. Do not force vertical editing into Monaco through a brittle transform if a safer editing projection is required.

---

## 6. H.7 Authoring Architecture Freeze

Canonical planning has since added H.7 before distribution work.

Source:
`MAGINALIA_IDE/plan/22_WORKDESK_BROWSER_INSTALLER.md`

H.7 is the last major authoring-focused update before Installer hardening.

Important planned areas include:

- reliable Workdesk/Shelf authoring flow;
- tab drag/reorder;
- editable live Preview that round-trips to the same Markdown source;
- basic Markdown formatting actions;
- figure/table/fenced-code insertion;
- rendered-table editing controls;
- Properties-style front-matter editing;
- Project composition via Synced Blocks;
- derived Bibliography View.

H.6 renderer-quality work remains separate and is not replaced by H.7.

Do not opportunistically implement all H.7 while fixing H.5/H.6.

---

## 7. Distribution / Browser order

Current direction:

```text
H.5 Reviewer integration/recovery
-> H.6 Renderer/editor quality
-> H.7 Authoring Architecture Freeze
-> Installer readiness audit
-> Windows Installer + Japanese manual
```

Browser/Web View is no longer a mandatory Core blocker.

Accepted D039:
Browser/Web View should be an **official optional Mod**, unchecked by default in the ordinary installer. When absent, use the external browser.

Normal Windows installation must require no terminal/developer dependency knowledge and must preserve Workdesk/Projects/Shelf/research files on uninstall.

Before final Installer hardening, use Harness 01 on an exact frozen SHA.

---

## 8. Post-alpha direction

Accepted roadmap decisions from 2026-09-26:

- alpha closes when the ordinary flow reaches resolved Markdown + PDF + DOCX export;
- production Git/GitHub Sync remains outside the alpha blocker while D032 is active;
- post-alpha line is **beta 1.0 “Ethiopia”**;
- early Ethiopia Core focuses on Cross-surface Selection, Research Library/Shelf, Default Knowledge Importer, Floating Lookup, and Research Discovery;
- large later first-party capabilities should use explicit module/registry boundaries similar to public Mods;
- Browser, science/LaTeX, advanced docking/AI are not automatic Ethiopia release blockers.

Canonical:
- `MAGINALIA_IDE/plan/23_POST_MVP_IMPLEMENTATION_ROADMAP.md`
- `MAGINALIA_IDE/plan/24_RESEARCH_LIBRARY_SHELF.md`
- Decision Log D037-D051.

---

## 9. Non-negotiable architecture

### Data / ownership

- Local-first.
- Ordinary portable formats remain the durable user source of truth.
- Workdesk is parent/navigation, not owner of child Project contents.
- Parent Workdesk History must never absorb child Project data or child `.git`.
- Private Shelf remains separate.
- Machine-local absolute paths stay machine-local.
- User research data is not disposable app state.

### Contracts

- Cross-product integration uses versioned contracts + adapters.
- Do not import another product's internal implementation as the long-term boundary.
- Reviewer backend may be salvaged into this repo for packaging, but Desktop integration still treats its HTTP/API contract as the boundary.
- QuoteRef stores opaque Reviewer identity, not resolved quote text/provenance payload.

### Git

D032:
production Git/GitHub fetch/pull/push/auth/conflict orchestration is frozen pending human code review capability.

Do not reopen it because OpenCode has stronger automation.

### UI

Primary user is a nontechnical humanities student/researcher/writer.

Normal UI should use research/writing vocabulary, not infrastructure vocabulary.
Do not require knowledge of Git, SQLite, Python, OCR internals, repository topology, or process ports.

---

## 10. OpenCode execution context

Development moved from Codex Desktop to OpenCode on 2026-09-27.

Canonical execution-process source:
`MAGINALIA_IDE/plan/25_DEVELOPMENT_RUNTIME_HARNESSES.md`.

Boundary:

```text
Chat / Product Owner
  -> Development Request Contract
  -> OpenCode Runtime
  -> Harness
  -> Git commit + evidence + Implementation Handoff Report
  -> Chat / Product Owner
```

Runtime responsibilities include:

- harness selection;
- decomposition;
- model routing;
- retries/escalation;
- verification order;
- structured progress telemetry;
- human STOP;
- quota supervision;
- safe checkpoint;
- persistent resume/handoff.

Human STOP always overrides auto-continuation.

Acceptance values are exactly:

- PASS
- FAIL
- NOT VERIFIED

Missing evidence is not PASS.

### Current local runtime conventions

These are operational defaults, not product contracts and may be tuned without product-plan edits:

- engineering language: English;
- Chat interprets Japanese Product Owner requests and sends structured English Development Requests;
- OpenCode does not need an internal translation agent;
- Japanese product/installer/user-facing text must remain Japanese where required;
- GPT-6 Luna Max is the normal implementation worker;
- GPT-5.6 Terra-class reasoning is preferred for lead/escalation/replanning when cost-effective;
- heavier Sol-class reasoning is reserved for difficult architectural judgment rather than used mechanically on every task;
- exact model routing belongs to Runtime, not individual product requests.

Recent provider direction:

```text
CodexExecutionProvider
  -> codex exec
  -> ChatGPT-authenticated Codex CLI
```

Do not invent a Codex MCP configuration when the installed CLI does not expose the required MCP server interface.

The common engineering Runtime lives outside product code (for example under the user's OpenCode config); product knowledge and implementation truth remain in the repository.

---

## 11. What an OpenCode session should do next

For ordinary implementation:

1. verify base commit;
2. load this memory;
3. read relevant canonical MAGINALIA_IDE plan/ADR;
4. inspect current code/tests;
5. choose/run the registered Harness through Runtime;
6. keep changes bounded to one Primary Outcome;
7. produce evidence;
8. commit;
9. emit Implementation Handoff Report.

For current H.5 specifically:

1. read `memory/ANTIGRAVITY_DEBT.md`;
2. audit the unfinished sidecar work rather than trusting it;
3. preserve good salvage;
4. remove/rework unsafe/brittle pieces;
5. prove real sidecar start/readiness/shutdown;
6. only then continue Desktop UI/Shelf integration.

---

## 12. Do not let this file become a diary

Keep this file small enough to read every session.

Update it only when one of these changes:

- verified current baseline;
- active Primary Outcome;
- accepted architecture/product decision;
- critical known debt;
- execution-runtime boundary;
- next milestone order.

Detailed implementation history belongs in Git, canonical plans, or dedicated debt/handoff documents.
