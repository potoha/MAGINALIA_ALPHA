# MAGINALIA Development Manifesto

Status: normative project policy  
Date: 2026-08-16

## 1. 何を作るのか

MAGINALIA は、人文学の「読む・引用する・注釈する・考える・書く・レビューする・公開する」を、可搬な研究データの上で接続する **IDE for the Humanities** です。

完成品を一枚岩にすることは目的ではありません。目的は、独立した道具が共通 contract を介して協調し、ひとつの研究体験に見えることです。

```text
Capture / Note  ─┐
Writer           ├─ portable contracts ─ MAGINALIA IDE ─ Git / GitHub
Other tools      ┘

                    ↓ optional local orchestration
                 Workspace
```

## 2. 四つの開発原則

### Start simply

最初から高度な自動化を作らない。人間が1回操作すれば通る一本道を先に作り、繰り返しが痛くなったところだけ自動化する。

### Divide and conquer

機能を UI、domain、persistence、integration adapter に分ける。外部 API の都合を domain model に直接持ち込まない。

### 餅は餅屋

- source control は Git
- remote hosting / Pages / Releases は GitHub 等の provider
- OCR は差し替え可能な OCR engine
- editor substrate は Code-OSS / VS Code Extension API
- PDF/DOCX 生成は将来 Pandoc / Vivliostyle 等の専門 tool
- AI inference は external / local provider

MAGINALIA 自身が再実装するのは、人文学固有の workflow、data contract、UI、privacy boundary、tool orchestration だけです。

### 説明できること

プロジェクト代表がコードを書けなくても、次を説明できる状態を維持します。

- どの unit が何をするか
- 何が source of truth か
- どこからどこへデータが移動するか
- 失敗すると何が残るか
- どの外部 tool を交換できるか
- public/private の境界がどこか

説明できない coupling は技術的負債とみなします。

## 3. Backend-minimal policy

MAGINALIA プロジェクトは、**常設バックエンドをできるだけ持たない**ことを原則とします。禁止ではなく、維持コスト・障害点・privacy surface を増やさないための設計優先順位です。

優先順位は次です。

1. 端末内処理で済ませる
2. ordinary files / local Git で済ませる
3. GitHub / GitHub Pages / Releases / Actions 等の既存基盤で済ませる
4. ユーザー自身の repository / Pages / self-hosted adapter で済ませる
5. 外部 provider へ直接接続する
6. それでも不自然な場合だけ、MAGINALIA 側で小さな backend を持つ

### 許容しやすい backend

- 公式配布ページ / ダウンロードページ
- 静的サイト
- 低頻度・低状態の薄い補助 API
- OAuth callback / token exchange 等、client-only では安全に成立しない一点のための小さな endpoint
- user data を正本として保持しない stateless / near-stateless function

### 原則避ける backend

- MAGINALIA account database
- 独自 cloud sync database
- 常設 OCR server
- hosted research data store
- telemetry collection backend
-独自 collaboration server
- Workspace 専用の必須 cloud control plane
- client が backend 不通で研究データへアクセスできなくなる設計

backend を入れる場合は次を満たします。

- 研究データの正本を置かない
- backend が落ちても local data を失わない
- state を最小化する
- 代替 path / export path を残す
- 維持コストを一文で説明できる
- security/privacy surface を ADR に記録する

「serverless だから無料」「アクセスが少ないから安全」を理由に無制限に増やしません。

## 4. Data first, app second

研究データの正本は ordinary files です。

- Markdown
- YAML
- JSON
- images / attachments
- Git history

SQLite / IndexedDB / local cache / search index は高速化や working state に使ってよいが、唯一の正本にしません。

MAGINALIA が明日消えても、利用者が研究成果を救出できることを最優先します。

## 5. Independent but composable

各 product は単独利用可能でなければなりません。

### MAGINALIA IDE

普通の Markdown repository を開き、編集・履歴・引用参照・publish を扱える。

### MAGINALIA Note / Capture

スマートフォン単体で ISBN → capture → OCR → 人間による修正 → portable annotation の保存／export まで行える。

### MAGINALIA Writer

MAGINALIA IDE がなくても入力支援として使える。provider を差し替えられる。

### Workspace

独立 product を cloud account で囲い込むものではない。ローカル設定、共通 repository、context handoff、version compatibility をまとめる統合体験です。

## 6. 接続は contract、共有実装は最小限

product 間で相手 repo の internal module を直接 import しません。

共有するのは次だけです。

- stable IDs
- versioned schemas
- Markdown conventions
- repository layout
- command / event payload contract
- provider interfaces

共有 library を作る場合も、UI や product-specific state を混ぜません。

## 7. Redundancy is deliberate

ここでいう冗長性は「同じ処理を何度も書くこと」ではなく、単一障害点を作らないための逃げ道です。

- GitHub がなくても local repository は残る
- IDE がなくても Markdown は読める
- Note がなくても annotation JSON を読める
- Writer provider が落ちても mechanical fallback が残る
- online OCR がなくても client/local OCR path が残る
- Workspace がなくても各 product は起動する
- optional backend が落ちても export/import path が残る

## 8. IDE policy

MAGINALIA Desktop は Code-OSS の thin overlay を維持します。

MAGINALIA 固有機能は可能な限り **同じ extension codebase** から、

1. MAGINALIA Desktop の built-in extension
2. 通常の Visual Studio Code で動く extension

の両方を生成します。

Code-OSS core patch は最後の手段です。UI刷新もまず View Container / Tree View / Commands / Custom Editor / Webview 等の extension API で実現し、core patch が必要な変更だけ ADR にします。

## 9. OSS policy

OSS 版を意図的に不便にしません。

OSS に置くべきもの:

- data format / schemas
- core clients
- provider interfaces
- Git/GitHub basic integration
- export/import
- basic publish
- basic annotation flow

商用価値を作るなら、管理・配布・署名・サポート・公式 model assets・導入支援等に置き、研究データの可搬性を人質にしません。

## 10. Scope discipline

新機能を思いついたことは実装理由になりません。

各 milestone は必ず次を持ちます。

- one-sentence goal
- must-have end-to-end flow
- explicit non-goals
- acceptance criteria
- rollback / fallback

「便利そう」は backlog に入れられますが、現在 sprint へ入れるには current milestone の bottleneck を解消する必要があります。

## 11. 最終判断基準

迷ったら次の順で判断します。

1. 利用者の研究データは残るか
2. 小さく作れるか
3. unit を独立させられるか
4. 専門 tool に任せられるか
5. backend を増やさずに済むか
6. 非プログラマが図で説明できるか
7. OSS contributor が交換・拡張できるか

全部に Yes と言えない実装は、急いで main に入れません。
