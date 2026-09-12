# Repository Audit

Date: 2026-08-16  
Scope: `potoha/MAGINALIA_IDE`, `potoha/MY_marginallia`, `potoha/Uttate-writer`, `potoha/toybox`

## 判定記号

- **KEEP**: 現行設計へそのまま活かす
- **REFACTOR**: 発想・機能は残し、境界を整理する
- **LEGACY**: 動く参照実装として残すが新機能の主戦場にしない
- **DEFER**: 将来候補。現在 milestone では実装しない
- **DROP**: 正規設計から外す。必要なら履歴だけ残す

---

## 1. `MAGINALIA_IDE`

### 現状評価

この repo は4つの中で最も「今後の共通基盤」に近い。既に以下が存在する。

- portable data を正本にする architecture
- Format v0.1 / validator
- publisher package
- Code-OSS thin overlay
- built-in extension
- Git / GitHub process boundary ADR
- private → public publication boundary ADR
- reproducible Windows packaging の入口

### KEEP

- `spec/`
- `packages/format/`
- `packages/publisher/`
- `extensions/maginalia/`
- `overlay/`
- `scripts/overlay.mjs`
- `docs/decisions/0001..0005`
- CI で Code-OSS build を行い、local 開発では full upstream build を必須にしない方針

### REFACTOR

1. **extension を product shell から domain unit へ分割**
   - project
   - library / annotations
   - preview
   - git
   - repository provider
   - publish
   - UI adapters

2. **同一 source から built-in と VS Code extension を生成**
   - `extensions/maginalia` を本体とする
   - Desktop 固有機能は adapter / feature flag で分離

3. **plan と docs の役割整理**
   - `plan/`: living roadmap / scope / sprint / decision index
   - `docs/`: 実装済み仕様 / architecture / ADR / usage

4. **UI刷新の責務を extension-first に限定**
   - native VS Code contribution API を優先
   - core patch は ADR 必須

### DEFER

- Word import/export
- production PDF
- full CJK typography
- installer signing
- auto update server
- collaboration server
- Archive / Hive crawler

### 判定

**Main foundation.** 今後の共通 contract と integration design の正本にする。

---

## 2. `MY_marginallia`

### 現状評価

二つの系統が同居している。

1. `APK/`: Android Capture + Windows PC reviewer
2. `miniapp/`: browser / LINE MINI App Capture

どちらも ISBN → capture → OCR → human review → portable record という本質は共有しているが、保存 contract と転送方式が異なる。

### KEEP

#### `miniapp/`

- ISBN scanner
- openBD adapter
- page capture
- rectangle selection
- client-side OCR
- IndexedDB working state
- UI shell
- capture domain の unit 分割
- GitHub storage adapter の考え方

特に `src/core/` と外部依存を adapter に出す構成は今後の Note α1 の基準にできる。

#### `APK/`

- CameraX / ML Kit を使った native capture の知見
- Room migration test
- normalized coordinate
- PHONE → PC manifest contract
- PC reviewer の OCR / human approval flow
- raw image と public record を分離する privacy boundary

### REFACTOR

1. **製品名と domain を MAGINALIA Note / Capture に統一**
   - repo 名の改名は急がない
   - code namespace の一括 rename も後回し

2. **共通 annotation contract へ adapter 変換**
   - APK contract を壊して直接統合しない
   - miniapp contract も直接 IDE internal model にしない
   - `CaptureRecord -> Marginalia Annotation` converter を設ける

3. **no-owned-backend への適合**
   - 現在の `miniapp/api/github-auth.ts` serverless OAuth は正規 β route から外す
   - α実験として履歴は残す
   - browser-only auth は安全性を検証してから別 ADR
   - 安全な direct auth が成立しない場合、portable export/import を正式 route とする

4. **repo root の重複整理**
   - 現在 `APK/` と root `app/` が混在しているため、正規 path を明示する
   - build cache / `.kotlin` 等が追跡されている場合は除去対象

### LEGACY

`APK/` は native client の参照実装として価値が高いが、α1 の主戦場を browser miniapp と同時に二本立てにすると scope が割れる。

当面:

- browser miniapp = Note α1 reference client
- APK = legacy/reference + native-specific experiments

とする。

### DROP from canonical architecture

- MAGINALIA 運用の OAuth callback server
- MAGINALIA 独自 account DB
- cloud OCR を必須にする経路

### 判定

**Keep the domain, reduce duplicated product paths.**

---

## 3. `Uttate-writer`

### 現状評価

既に「Provider を差し替えながら入力体験を検証する研究プロトタイプ」として成立している。

### KEEP

- Python 3.12 + PySide6 prototype
- mechanical normalization
- Local AI / OpenAI / Gemini provider abstraction
- protected placeholder flow
- fallback candidate
- review UI
- dataset curator / builder
- user-selected training data policy
- local-first prompt/profile idea

### REFACTOR

1. core と UI を明確に分離

```text
writer-core
├ normalizer
├ chunk model
├ candidate model
├ protection
├ context selector
└ provider interface

adapters
├ local-openai-compatible
├ openai
├ gemini
└ future-model-runtime

ui
└ PySide6
```

2. MAGINALIA integration を direct import ではなく context contract にする

Writer は Research Project 全体を読む権限を持たない。IDE が明示選択した context bundle だけを渡す。

3. Uttate 名は repo/history として残し、MAGINALIA Writer への branding rename は β前の独立 decision とする。

### DEFER

- Official Writer Model の本格学習
- model weights の販売・entitlement
- OS-level IME 化
- 常時 background context collection
- Workspace cloud context

### 判定

**Strong prototype. Preserve algorithms and provider boundaries, shrink coupling.**

---

## 4. `toybox`

### 現状評価

企画と discussion の second brain。実行時依存にはしない。

### KEEP

- MAGINALIA discussion summaries
- business / OSS philosophy
- product concepts
- historical rationale

### Rule

`toybox` の文書は **input to planning** であり、application の runtime contract ではない。

決定済み事項は `MAGINALIA_IDE/plan` または ADR へ昇格してから実装する。

### 判定

**Historical and ideation source, not an implementation dependency.**

---

# Target repository topology

当面は monorepo 化しない。

```text
potoha/MAGINALIA_IDE
  ├ format specification
  ├ common TypeScript contracts
  ├ IDE extension
  ├ Code-OSS overlay
  ├ publisher
  └ project plan / ADR

potoha/MY_marginallia
  └ MAGINALIA Note / Capture clients and capture-specific adapters

potoha/Uttate-writer
  └ MAGINALIA Writer prototype and future standalone client

potoha/toybox
  └ discussions / ideas / historical records
```

## Why not merge now

- release cadence が違う
- language / runtime が違う
- failure domain が違う
- contributor が部分的に参加しやすい
- standalone usability を守りやすい

共通化は repo 統合ではなく **versioned contract** で行う。

---

# Immediate cleanup backlog

Priority A:

1. `MAGINALIA_IDE` を contract / plan の正本にする
2. common Annotation / Context / Repository Provider の schema を設計する
3. miniapp serverless OAuth を canonical path から外す
4. IDE extension の built-in / VS Code extension dual-build を設計する
5. Writer core/provider/UI boundary を明文化する

Priority B:

6. `MY_marginallia` root duplicate directories を調査・整理
7. historical docs の status header を統一
8. repo ごとに `ARCHITECTURE.md` への短い入口を置く
