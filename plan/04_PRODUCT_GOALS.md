# Product Goals and Version Manifest

Status: scope contract  
Date: 2026-08-16

この文書は各 release で **何を作るか / 何を作らないか** を固定します。

Version は機能数ではなく、利用者が通せる end-to-end flow と contract stability で判定します。

---

# 0. Version meaning

## α1

**目的:** その product が解く一つの問題を、実データで最初から最後まで通せる。

- developer / early adopter 向け
- UI は荒くてよい
- data loss は許容しない
- schema / interface はまだ変更可能
- explicit manual step を許容
- automatic convenience より観測可能性を優先

## β1

**目的:** 一般の技術に詳しくない利用者へ渡し、主要 workflow を説明なしでも反復できる。

- migration path がある
- recovery / error UX がある
- cross-product contract が versioned
- install/update path が説明できる
- privacy boundary が UI から分かる
- basic accessibility / keyboard navigation
- telemetry を必須にしない

## Workspace β1

**目的:** 独立して完成した product を、同じ研究環境として接続する。

Workspace β1 は「全部入り巨大アプリ」ではありません。

---

# 1. MAGINALIA IDE α1

## One-sentence goal

**普通の repository を Research Project として開き、Markdown を書き、引用を参照し、Git history を意識しすぎずに一回の Update / Sync / Publish を通せる。**

## Must build

### Project

- New Research Project
- Open Research Project
- `.marginalia/project.yml`
- portable folder structure
- format validation

### UI

- MAGINALIA-specific Home / Project Overview
- Projects view
- Sources / Annotations view の最小版
- Markdown editor は標準 editor を最大限利用
- horizontal / vertical preview
- ruby preview
- developer-oriented Run/Debug/Terminal を標準導線の主役にしない

### Git / GitHub

- Changes
- Update = commit
- Sync = fetch/pull/push の安全な orchestration
- ff-only / conflict detection
- failure 時 local work preservation
- GitHub repository との接続を一回通す

### Annotation

- stable annotation ID
- annotation reference `{{annotation:...}}` の parse / resolve technical slice
- missing reference を壊さず表示

### Publish

- explicit preview
- allowlisted projection
- private project → Published Library
- static shelf の最小生成

### Distribution

- MAGINALIA Desktop built-in extension
- 同じ source から VS Code extension を build できる technical proof

## Explicit non-goals

- Word import/export
- production-grade PDF
- full Japanese typography
- real-time collaboration
- account system
- cloud sync DB
- Hive / global archive
- Input integration
- Quote Capture automatic sync
- extension marketplace 完成
- auto updater
- installer signing

## α1 acceptance gate

A fresh user can:

1. install/open a build
2. create project
3. write Markdown
4. create/read one annotation
5. make one Update
6. Sync to remote
7. preview publish set
8. create static published output
9. reopen on another clone without proprietary database

---

# 2. MAGINALIA IDE β1

## One-sentence goal

**非プログラマが Git を直接学ばなくても、研究 project を数週間継続して壊さず使える。**

## Must build

- stable Project / Source / Annotation contracts
- migration command + backup before migration
- Library / Projects / Sources / Reviews navigation
- search/index rebuilt from portable files
- conflict explanation UI
- recovery for interrupted publish/sync
- public/private badge and publish boundary visibility
- VS Code extension distribution path
- Desktop distribution path
- extension contributor documentation
- basic import/export escape hatch
- static shelf with share metadata
- compatibility matrix for Quote Capture / Input contract versions

## Explicit non-goals

- Google Docs-like simultaneous editing
- hosted project storage
- institution admin console
- mandatory login
- AI-generated research writing as core UX
- proprietary project format
- perfect compatibility with every Markdown extension
- general programming IDE replacement

---

# 3. MAGINALIA Quote Capture α1

## One-sentence goal

**スマホで ISBN を読み、引用したい範囲だけを撮影/OCRし、人が直した引用を portable annotation として安全に持ち出せる。**

## Reference implementation

`MY_marginallia/miniapp` を α1 reference client とする。

Existing Android APK is kept as native reference / legacy implementation.

## Must build

- ISBN-13 scan + manual fallback
- openBD bibliography provider
- page capture / photo fallback
- region selection
- selected-region-only client OCR
- horizontal + vertical Japanese OCR path
- human correction
- comment
- local IndexedDB working state
- versioned CaptureRecord
- CaptureRecord → canonical Annotation converter
- portable export/import
- static hosting
- optional GitHub storage path only if auth design passes security review

## Explicit non-goals

- full-page OCR archive
- automatic whole-book digitization
- cloud image storage
- central account
- background sync
- push notification
- automatic conflict merge
- social network
- public quote sharing service

## α1 acceptance gate

Offline after initial app load where browser permits, user can complete:

ISBN → metadata → capture → select → OCR → correct → comment → export

without losing the original working state.

---

# 4. MAGINALIA Quote Capture β1

## One-sentence goal

**数十冊・数百引用を扱っても、端末と repository の境界が理解でき、IDEへ確実に受け渡せる。**

## Must build

- library/book/annotation navigation
- robust local backup/export
- canonical Annotation v1 compatibility
- explicit local vs exported state
- duplicate ISBN / duplicate annotation handling
- basic capture quality checks
- GitHub integration or documented export/import as equal first-class paths
- PWA install path where stable
- optional LINE adapter without core dependency
- privacy explanation in UI

## Explicit non-goals

- central MAGINALIA sync service
- server-side OCR as required path
- hosted photo backup
- collaborative annotation
- publisher-wide corpus search

---

# 5. MAGINALIA Input α1

## One-sentence goal

**IMEを止めずにラフ入力を続け、mechanical + provider-assisted candidates を後から人間がレビューし、採用した文字列を元の入力先へ返せる。**

## Product boundary

MAGINALIA Input は日本語入力支援ツールであり、文書エディタではない。

It may integrate with MAGINALIA IDE or another editor, but the host editor owns:

- manuscript/document files
- document structure
- long-form editing
- history
- publishing

Input owns only the input-assistance lifecycle.

## Must build

- chunk input without blocking next chunk
- mechanical reading normalization
- protected strings / placeholders
- Local OpenAI-compatible provider
- OpenAI adapter
- Gemini adapter
- provider failure fallback
- candidate review
- return accepted text to the host/input target
- explicit context bundle input
- no automatic repository crawl
- curated dataset export remains opt-in
- core / provider / UI unit boundary

## Explicit non-goals

- document editor
- manuscript/project ownership
- Markdown editor
- long-form document management
- publishing
- OS-level IME replacement
- Official Input Model production training
- continuous full-document upload
- automatic style imitation from all user files
- invisible background learning
- mandatory Workspace subscription

## α1 acceptance gate

The same saved rough-input fixture can run through:

mechanical only / local provider / cloud provider

and Input always preserves original text plus reviewable candidates, then returns accepted text without taking ownership of the document.

---

# 6. MAGINALIA Input β1

## One-sentence goal

**Providerを意識せず普段の入力先で使えつつ、どの文脈がどこへ送られるかは明確に選べる日本語入力支援になる。**

## Must build

- stable provider interface
- provider capability detection
- context permission UI
- personal dictionary / preferred conversions
- local profile export/import
- latency / timeout UX
- provider-specific privacy disclosure
- IDE Context Bundle v1 support
- host-editor handoff contract
- crash-safe session restore
- packaging for normal users

## Explicit non-goals

- universal writing agent
- standalone document editor
- autonomous long-form article generation
- hidden training on user text
- cloud-only profile
- Official Input Model as a β1 blocker

---

# 7. MAGINALIA Workspace β1

## One-sentence goal

**IDE・Quote Capture・Inputを別々の道具のまま、一つの研究 project に自然に出入りできるようにする。**

## Must build

### Local integration

- detect installed MAGINALIA products
- version compatibility matrix
- open the same Research Project across products where that product needs project access
- deep-link / file-based handoff
- IDE → Input explicit Context Bundle
- Quote Capture → IDE canonical Annotation import
- Input → host editor accepted-text handoff
- shared product-independent identifiers
- local diagnostics screen/report

### Distribution convenience

- official download page
- current compatible releases metadata
- links to GitHub Releases
- static documentation

### Optional thin backend

Only if justified:

- small compatibility/download metadata endpoint
- OAuth exchange helper

No research data source of truth.

## Explicit non-goals

- hosted Workspace account
- central research sync
- proprietary cloud project format
- admin SaaS
- remote feature flags required for startup
- mandatory subscription gate for OSS client integration
- copy of Quote Capture/Input/IDE domain logic inside Workspace

## β1 acceptance gate

On one machine a user can:

1. create/open a project in IDE
2. create an annotation in Quote Capture and bring it into that project
3. select limited project context and open Input
4. use Input to produce reviewed text and return it to the host editor
5. Update/Sync in IDE
6. publish static output

At each step, one product can be removed without making the remaining project unreadable.

---

# 8. Post-β1 backlog, explicitly outside current commitment

- MAGINALIA Hive / public index
- institution Workspace / admin
- official Input Model weights
- model entitlement / sales
- managed AI gateway
- large-scale archive crawler
- hosted share URL service
- real-time collaboration
- institutional SSO
- mobile native rewrite if web client proves insufficient
- full publishing production pipeline

These may become products later. They are not excuses to complicate α1/β1 contracts now.
