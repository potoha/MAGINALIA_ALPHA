---
id: roadmap.distribution
updated: 2026-09-28
status: active
kind: roadmap
canonical:
  - MAGINALIA_IDE/plan/22_WORKDESK_BROWSER_INSTALLER.md
  - MAGINALIA_IDE/plan/23_POST_MVP_IMPLEMENTATION_ROADMAP.md
  - MAGINALIA_IDE/plan/09_DECISION_LOG.md
---

# Distribution roadmap

Near-term order:

```text
H.5 Reviewer integration/recovery
-> H.6 Renderer/editor quality
-> H.7 Authoring Architecture Freeze
-> Harness 01 Installer Readiness audit
-> Windows Installer + Japanese manual
```

Browser/Web View is not a mandatory Core blocker.

Accepted D039:
- Browser/Web View becomes an official optional Mod;
- unchecked by default in ordinary installer;
- external browser is fallback when Mod is absent.

Installer normal-user path:
- no terminal;
- no Node/Python/PATH/npm/pip setup;
- preserve Workdesk/Projects/Shelf/research files on uninstall.

Alpha close direction:
- ordinary authoring flow reaches resolved Markdown + PDF + DOCX export;
- D032 production Git/GitHub Sync is not an alpha blocker.

Post-alpha line:
- beta 1.0 “Ethiopia”;
- early Core focus includes Cross-surface Selection, Research Library/Shelf, Default Knowledge Importer, Floating Lookup, Research Discovery.
