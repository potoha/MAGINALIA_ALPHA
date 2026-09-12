# Risk Register

Status: living risk register  
Date: 2026-08-16

Scale:

- Probability: Low / Medium / High
- Impact: Low / Medium / High / Critical

A risk is not a reason to stop. It is a reason to place a boundary and a trigger.

---

| ID | Risk | Probability | Impact | Mitigation | Trigger / owner action |
|---|---|---|---|---|---|
| R001 | Code-OSS UI cannot be simplified enough through Extension API alone | High | High | Week 1 feasibility matrix; allow small Desktop-only patches with ADR | If > small auditable patch set is required, reduce UI ambitions or redesign shell |
| R002 | Core patches make upstream updates expensive | Medium | High | thin pinned overlay; patch inventory; removal condition per patch | Patch count/size grows for 2 cycles → architecture review |
| R003 | IDE / Note / Writer schemas drift | High | Critical | canonical versioned contracts + shared fixtures + adapters | Any direct cross-repo JSON assumption → block merge |
| R004 | Canonical schema becomes union of every product-specific field | Medium | High | small core + namespaced extensions/sidecars | Core fields added for one client only → contract review |
| R005 | Browser Note GitHub auth requires backend complexity | Medium | Medium | export/import first-class; thin OAuth endpoint only if benefit justifies | Auth work exceeds one sprint or needs user-data DB → remove from α1 path |
| R006 | User must learn Git to recover errors | High | High | humanized error mapping + Advanced details + usability tests | User test requires explanation of branch/remote/token → β1 UX blocker |
| R007 | Installer leaks developer prerequisites | High | High | user/dev setup split; bundled/detected prerequisites | Clean machine requires terminal/PATH → β1 release blocked |
| R008 | Git or GitHub outage blocks writing | Low | Critical | local-first project state; sync is optional | Any write path requires remote → redesign |
| R009 | Publication leaks private capture/OCR data | Medium | Critical | allowlisted projection + negative privacy fixtures + explicit preview | Forbidden field appears in projection test → P0 |
| R010 | Writer sends too much research context to cloud provider | Medium | Critical | explicit Context Bundle; payload tests; no repo crawl | Provider payload contains unselected content → P0 |
| R011 | AI/provider failure blocks input | Medium | High | mechanical fallback + original rough input preserved | Provider exception loses chunk/candidate state → P1 |
| R012 | Note OCR quality is insufficient for vertical/Japanese text | Medium | Medium | OCR adapter; manual correction; native reference client | Correction cost defeats capture value → evaluate better local OCR adapter |
| R013 | Web camera/storage platform limitations hurt Note reliability | Medium | High | PWA/browser spike; native Android reference remains available | Browser cannot preserve working state reliably on target phones → reconsider native primary client |
| R014 | Three repos create contributor coordination overhead | Medium | Medium | contract repo ownership; compatibility matrix; release notes | frequent lockstep commits required → reconsider shared package/repo topology |
| R015 | Monorepo temptation creates unnecessary coupling | Medium | Medium | keep independent repos until shared release/failure domain exists | shared code requires synchronized release every sprint → architecture review |
| R016 | Codex spends weekly quota on broad refactors | High | High | one Primary Outcome/week; acceptance-first work packets | sprint has >1 unrelated subsystem → split before implementation |
| R017 | Existing working code is rewritten unnecessarily | Medium | High | repository audit KEEP/REFACTOR/LEGACY decisions | rewrite proposed without measured blocker → require rationale |
| R018 | Product names / old `marginalia` namespaces cause premature rename churn | High | Medium | separate brand rename from data namespace decisions | bulk rename touches contracts without functional need → defer |
| R019 | OSS extension points become arbitrary plugin execution/security surface | Medium | High | interfaces at build/install level first; no dynamic untrusted code required for α1 | runtime plugin loading proposed → threat model first |
| R020 | Static shelf grows into a hosted social platform accidentally | Medium | Medium | static user-owned Pages is default; Hive/share services are separate future products | feature requires central user/content DB → new product decision |
| R021 | Workspace duplicates standalone product logic | Medium | High | launcher/compatibility/handoff only | domain code copied into Workspace → block and expose contract instead |
| R022 | Settings overwhelm nontechnical users | High | Medium | progressive disclosure; Advanced mode | normal Settings grows provider/path/schema knobs → move behind Advanced |
| R023 | Dependencies or upstream versions change under long development | Medium | Medium | lockfiles/pins; explicit upgrade sprint; monthly review | security/EOL issue → reprioritize upgrade sprint |
| R024 | License/marketplace/distribution constraints affect Code-OSS/extension release | Medium | High | keep attribution; official docs review before β1 distribution | distribution channel assumption changes → release ADR |
| R025 | Main maintainer cannot explain system after AI-generated growth | High | Critical | required architecture docs, Mermaid, Decision Log, unit responsibility statement | feature cannot be summarized without code archaeology → not Done |

---

# Top five active risks for Cycle 0

1. **R001** UI simplification boundary
2. **R003** contract drift
3. **R005** browser auth/backend scope
4. **R016** Codex scope explosion
5. **R025** explainability loss

Cycle 0 planning should reduce these before adding broad features.

---

# Monthly risk review

For each High/Critical risk:

- did probability change?
- did mitigation become real code/test or remain prose?
- did a trigger fire?
- can the risk be retired?
- did a new dependency create a new risk?

A risk that has fired becomes an issue/sprint outcome, not a permanent table entry only.
