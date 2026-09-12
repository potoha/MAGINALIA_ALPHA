# Initial Four-Week Development Plan

Cycle: 2026-08-17 → 2026-09-13  
Planning review: 2026-09-13  
Status: initial baseline

この4週間の目的は、各アプリを急いで完成させることではありません。

**「共通 contract を持つ独立 product」として再スタートできる状態を作り、IDE / Quote Capture / Input それぞれに一本ずつ壊れにくい α1 vertical slice を通すための土台を作る**ことです。

---

# Cycle success criteria

9月13日時点で次が満たされていれば成功です。

1. canonical Project / Source / Annotation / Context Bundle の責務が説明できる
2. Quote Capture が canonical Annotation を export できる
3. IDE が同じ Annotation fixture を読める
4. IDE の beginner-first UI 方針について extension / product config / core patch の境界が実測で分かる
5. 同じ MAGINALIA extension source を Desktop built-in と VS Code extension の両方へ出す path が確立または blocker が特定される
6. Input が explicit Context Bundle を core input として受け取れる
7. 主要 flow の Mermaid と tests が一致する
8. optional backend の用途と非用途が ADR で固定される

---

# Week 1: 2026-08-17 → 2026-08-23

## Primary Outcome

**Cross-product contract と beginner IDE shell の実装境界を固定する。**

### Repo

Primary: `MAGINALIA_IDE`  
Read/fixture validation: `MY_marginallia`, `Uttate-writer`

### In scope

#### A. Contract inventory

現在の:

- `MAGINALIA_IDE/spec`
- `MY_marginallia/APK/contracts`
- `MY_marginallia/miniapp/src/core`
- Input context-related structures in the legacy `Uttate-writer` repository

を比較する。

#### B. Canonical object boundaries

最低限:

- Project
- Source / Book
- Annotation
- Context Bundle

の ownership / ID / version / public-private fields を決める。

#### C. Annotation v1 draft

Quote Capture と IDE が共有できる **最小 canonical Annotation** を schema + fixture として追加する。

重要:

- APK schema を破壊しない
- miniapp internal model をそのまま canonical にしない
- adapter 変換で接続する

#### D. IDE UI feasibility spike

初心者向け shell の各変更について matrix を作る。

| Desired UX | Extension API | product/default config | core patch | Decision |
|---|---|---|---|---|
| MAGINALIA Home | investigate | investigate | investigate | |
| primary navigation reduction | investigate | investigate | investigate | |
| Terminal/Debugを前面から外す | investigate | investigate | investigate | |
| MAGINALIA terminology | investigate | investigate | investigate | |
| simplified settings entry | investigate | investigate | investigate | |

Code-OSS core patch はこの週では原則実装しない。必要性を証明する。

### Explicit non-goals

- Quote Capture UI rewrite
- Input UI rewrite
- turning Input into a document editor
- installer implementation
- final auth implementation
- full publish redesign

### Acceptance

- schema tests pass
- one canonical Annotation fixture exists
- IDE parser can validate/read fixture
- UI feasibility matrix completed
- any required core patch has ADR draft

### Codex packet order

1. contract audit
2. schema + fixtures
3. IDE reader test
4. UI spike
5. docs/ADR

---

# Week 2: 2026-08-24 → 2026-08-30

## Primary Outcome

**MAGINALIA IDE α1 の「文系ユーザーが研究を始められる入口」を一本通す。**

### Repo

`MAGINALIA_IDE`

### In scope

#### A. First-run / Home

- New Research Project
- Open Research Project
- GitHub connection is optional
- technical prerequisites are hidden from normal UX

#### B. Project Overview

最低限:

- project title
- recent documents
- sources / annotations count
- Changes state in human language
- primary action: Continue writing

#### C. Navigation reduction

Normal workflow の主役を:

- Projects
- Sources / 引用
- Editor
- Changes

へ寄せる。

Library / Inbox / Reviews は α1 で空の器だけなら前面に出しすぎない。

#### D. Dual extension build

同じ source から:

- built-in bundle
- development VSIX / installable extension artifact

を生成できる path を作る。

#### E. Error vocabulary

Git error を最低3ケース、人間向け message へ変換する。

- no remote
- network/auth failure
- merge/conflict required

### Explicit non-goals

- Code-OSSを完全に別UIへ作り替える
- custom file explorer 全面置換
- final installer
- auto update

### Acceptance

新規利用者目線で:

起動 → 新規Project → Markdown作成 → 保存 → Changes確認

まで Git 用語を知らずに進める。

VS Code extension 版でも同じ project を開ける。

---

# Week 3: 2026-08-31 → 2026-09-06

## Primary Outcome

**MAGINALIA Quote Capture α1 が canonical Annotation を安全に外へ出せる。**

### Repo

Primary: `MY_marginallia`  
Contract source: `MAGINALIA_IDE`

### In scope

#### A. miniapp adapter

Current flow:

ISBN → openBD → capture → region → OCR → correction

を維持したまま:

```text
CaptureRecord
  ↓ adapter
Canonical Annotation v1
  ↓
Export
```

を追加する。

#### B. Export first

必須:

- JSON export
- project/import folder へ持ち込める structure
- duplicate-safe ID
- schema validation before export

GitHub direct write は optional。

#### C. Backend auth decision

既存 OAuth serverless function について:

- 維持コスト
- secret requirement
- permission scope
- failure path
- export/importとの差

を評価する。

安全で UX 改善が十分大きい場合だけ thin backend として継続。そうでなければ α1 canonical path から外す。

#### D. IDE import smoke

Week 1 fixture ではなく **Quote Capture が実際に出力した annotation** を IDE が読む integration test を1本作る。

### Explicit non-goals

- APK と miniapp の同時完全統合
- background sync
- image cloud backup
- full book OCR

### Acceptance

スマホ:

ISBN → capture → OCR → correct → export

PC:

IDEでprojectを開く → annotationが認識される

が通る。

---

# Week 4: 2026-09-07 → 2026-09-13

## Primary Outcome

**IDE → Input の明示的 context handoff を通し、4週間の統合 smoke test を完成させる。**

### Repo

`MAGINALIA_IDE` + `Uttate-writer`

### In scope

#### A. Context Bundle v1

最小 fields:

- version
- project ID
- created_at
- selected items
- human-readable provenance

full repository path crawl はしない。

#### B. IDE export/handoff

利用者が選んだ:

- glossary
- selected excerpt
- source metadata

だけを Context Bundle にする。

#### C. Input parser

Input core が Context Bundle を受け取り、provider input に使える形へ変換する。

Providerへ送る前の最終 payload は既存 privacy/protection pipeline を通す。

Input は原稿を所有・編集するのではなく、候補を返す入力支援層として扱う。

#### D. Integrated smoke flow

最低一本:

1. IDE project open
2. Quote Capture annotation import
3. Markdown output references annotation
4. selected context → Input
5. Inputでレビューした text returns to host editor / output
6. IDE Update

### Stabilization

- contract tests
- docs
- Mermaid
- broken links
- Decision Log

### Monthly Review

9月13日に次月 scope を再計画する。

### Explicit non-goals

- Workspace GUI
- automatic Input launch on every keystroke
- Input-owned document editor
- full bidirectional live sync
- Official Input Model

---

# Cross-week backlog parking lot

この4週間に思いついても原則着手しないもの:

- Word import/export
- PDF production
- Hive
- hosted share service
- public quote network
- native Quote Capture rewrite
- official model training
- auto updater
- Workspace subscription system
- organization features

---

# Risks to watch

## R1. IDE UI simplification requires core patch

Response:

- Week 1 で feasibility を測る
- patch 数を最小化
- VS Code extension path を壊さない

## R2. Three different annotation models cannot converge cleanly

Response:

- canonical model を最小化
- product-specific data を extensions/sidecar に残す
- adapter migration, not destructive rewrite

## R3. Browser GitHub auth becomes backend-heavy

Response:

- export/import is first-class
- backend is optional thin convenience only

## R4. Input integration accidentally sends too much context

Response:

- explicit Context Bundle
- no repository crawl
- payload test fixtures

## R5. Codex tokens are consumed by broad refactors

Response:

- one Primary Outcome/week
- no unrelated cleanup
- stop at acceptance gate

---

# Re-plan trigger before 2026-09-13

月末を待たず再計画する条件:

- canonical contract causes data loss risk
- Code-OSS patch surface expands beyond a small auditable set
- browser platform makes Quote Capture α1 impossible
- security review rejects planned auth
- one sprint misses acceptance by more than one week

その場合は機能を増やさず、scope を縮小して vertical slice を守ります。
