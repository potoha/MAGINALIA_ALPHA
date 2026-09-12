# Technical Stack

Status: target stack for α1 → β1  
Date: 2026-08-16

この文書は「新しいものを全部採用するリスト」ではなく、**各責務を誰に任せるか**を固定するための技術選定です。

## 1. Selection rules

1. 現在動いている資産を優先する。
2. portable format を特定 framework に依存させない。
3. external system は adapter の後ろへ置く。
4. α1 中は major version upgrade を機能開発と同時に行わない。
5. dependencies を増やす前に標準 API / existing dependency で解けないか確認する。
6. product ごとの runtime の違いを無理に統一しない。
7. version は各 repo の lockfile / toolchain file を正本とする。

---

# 2. MAGINALIA IDE

## Runtime / language

| Concern | Choice | Current baseline | Why |
|---|---|---:|---|
| Core language | TypeScript | repo existing | VS Code extension ecosystem と一致 |
| Runtime | Node.js | 24.18.0 pinned | repo / upstream overlay の再現性 |
| Package manager | npm | 11.16.0 pinned | upstream と既存 workspace に合わせる |
| Editor substrate | Code-OSS | 1.132.1 / pinned commit | IDE shell を再実装しない |
| Extension API | VS Code API | pinned against target engine | Desktop / VS Code extension の共通面 |
| Tests | Node test + package tests | existing | dependency を増やさず contract を検証 |

## Repository packages

```text
packages/format
  portable schema / parser / validator / migration

packages/publisher
  private -> public projection / publication journal

extensions/maginalia
  application use-cases + VS Code UI adapter

overlay
  Code-OSS product branding / declared patches
```

### Planned extraction inside extension

```text
src/
├ domain/
├ application/
├ adapters/
│  ├ filesystem/
│  ├ git/
│  └ repository-provider/
└ ui-vscode/
```

最初から package を細分化しすぎない。**境界は folder/interface で先に作り、独立 versioning が必要になったら package 化**する。

## UI strategy

Priority:

1. native Commands
2. Tree View / View Container
3. standard text editor + decorations
4. readonly/custom preview
5. Webview only when native API is insufficient
6. Code-OSS core patch only after ADR

MAGINALIA Desktop と通常 VS Code extension の共通性を守るため、core patch 前提の機能を基本機能にしない。

## Git integration

- local source control: system Git
- advanced GitHub operations: `gh` where appropriate
- application interface: `RepositoryProvider`
- credentials: OS / GitHub CLI / provider-supported secure storage
- no credential in research repository

Git terminology is translated in normal UX but underlying Git history remains standard Git.

---

# 3. Marginalia Format

## Durable representation

- Markdown: human-authored prose
- YAML: project/front matter/config where human editing matters
- JSON: machine-oriented portable records / schema contracts
- images: original capture/assets where required
- Git: history and synchronization primitive

## Internal representation

```text
Markdown + metadata
        ↓
   Marginalia AST
        ↓
HTML / PDF / DOCX / Web / index
```

α1 は AST 全体を作り切らない。必要な node だけ増やす。

Candidate initial nodes:

- document
- paragraph
- ruby
- citation-reference
- annotation-reference
- footnote

---

# 4. MAGINALIA Note / Capture

## Reference α1 client: Web / PWA-oriented miniapp

| Concern | Choice | Current baseline |
|---|---|---:|
| Language | TypeScript | existing |
| Build | Vite | 7.x |
| Unit tests | Vitest | 3.2.x |
| Barcode | `@zxing/browser` | 0.2.x |
| Client OCR | Tesseract.js | 6.x |
| Working state | IndexedDB | browser native |
| Static hosting | GitHub Pages / equivalent static host | preferred |
| Platform adapter | optional LIFF | isolated from core |

### Why web first for α1

- no APK installation required
- current miniapp already has clean unit boundaries
- camera / barcode / client OCR path exists
- static hosting fits backend-minimal policy
- LINE-specific integration can remain optional adapter

### Native Android reference

Existing `APK/` remains a reference/legacy client using:

- Kotlin
- Jetpack Compose
- CameraX
- ML Kit barcode / Japanese text recognition
- Room as local working state

Room database is not cross-product source of truth.

## Backend

Default: none.

Thin optional endpoint may be used only for operations that cannot be safely implemented client-only, such as OAuth token exchange. It must not store captures, annotations, or research documents as canonical data.

---

# 5. MAGINALIA Writer

## α1 prototype/runtime

| Concern | Choice | Current baseline |
|---|---|---:|
| Language | Python | 3.12 only |
| Desktop UI | PySide6 | 6.8+ <7 |
| HTTP client | httpx | 0.28+ <1 |
| Tests | pytest / pytest-qt | existing |
| Lint | Ruff | existing |
| Packaging | Hatchling | existing |

## Architecture

```text
writer-core
├ mechanical normalizer
├ protection / placeholder
├ chunk model
├ candidate model
├ context bundle parser
└ provider interface

provider adapters
├ local OpenAI-compatible
├ OpenAI
├ Gemini
└ future dedicated runtime

ui
└ PySide6
```

## Model strategy

α1 / β1 で dedicated model は必須にしない。

Order:

1. mechanical conversion
2. provider-assisted candidate generation
3. explicit human review
4. curated dataset
5. only after product UX is validated: dedicated small model research

---

# 6. Workspace β1

Workspace は backend product ではなく local orchestrator とする。

Preferred implementation direction:

- TypeScript/Node if packaged with MAGINALIA Desktop
- or a very small platform-native launcher if later required
- config as portable/local text data
- deep links / CLI handoff / file contract for inter-product launch

Do not choose Electron/Tauri/etc. until Workspace β1 UI cannot be expressed as an IDE home/integration view plus small launcher.

---

# 7. Static web / publishing

Preferred:

```text
Published Library repository
       ↓ build
static HTML/CSS/assets
       ↓
GitHub Pages / user-owned static host
```

MAGINALIA does not need an application server for public shelves in the normal path.

Metadata for social sharing may be generated at build time.

---

# 8. Future specialist tools: adapter-first

Not α1 requirements, but architecture should leave these seams.

| Need | Candidate specialist |
|---|---|
| PDF / Japanese typesetting | Vivliostyle CLI |
| generic document conversion | Pandoc |
| diagrams | Mermaid |
| high-accuracy Japanese OCR | NDL OCR / replaceable OCR adapter |
| local model runtime | OpenAI-compatible local server / llama.cpp family / dedicated runtime |

These tools are subprocess/adapters, not domain dependencies.

---

# 9. Security / privacy stack rules

- secrets never committed
- browser bundle never contains confidential client secret
- smallest provider permission set
- no raw capture upload by default
- public projection is allowlist-based
- context sent to AI is explicit and minimal
- optional backend stores no research source of truth
- logs redact tokens, raw full documents, and capture images

---

# 10. Dependency update cadence

## Every sprint

- security alerts / broken builds only
- no opportunistic major upgrades

## Monthly planning review

- inspect upstream Code-OSS / VS Code changes
- inspect EOL/security changes for Node/Python/Android
- decide whether next month needs an explicit upgrade sprint

## Before β1

- one dependency freeze / reproducibility sprint
- clean machine build
- lockfile verification
- third-party notice/license review

---

# 11. Technical references

Primary references to re-check before changing architecture:

- VS Code Extension API: https://code.visualstudio.com/api/
- VS Code UX guidelines: https://code.visualstudio.com/api/ux-guidelines/overview
- VS Code Views guidance: https://code.visualstudio.com/api/ux-guidelines/views
- VS Code Webview guidance: https://code.visualstudio.com/api/ux-guidelines/webviews
- VS Code Custom Editors: https://code.visualstudio.com/api/extension-guides/custom-editors
- VS Code upstream contribution/build guidance: https://github.com/microsoft/vscode/wiki/How-to-Contribute
- GitHub authentication docs: https://docs.github.com/en/apps
- GitHub Pages docs: https://docs.github.com/en/pages

Exact versions remain controlled by repository lockfiles and pinned upstream manifests, not by this prose document.
