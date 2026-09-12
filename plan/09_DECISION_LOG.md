# Decision Log

Status: living index  
Last updated: 2026-09-12

このファイルは短い決定台帳です。重大な architecture decision は `docs/decisions/` の ADR が正本です。

Status:

- **Accepted**: 実装方針として採用
- **Proposed**: spike / review 後に確定
- **Superseded**: 後の決定に置換
- **Rejected**: 採用しない

---

| ID | Date | Status | Decision | Rationale / consequence |
|---|---|---|---|---|
| D001 | 2026-08-16 | Accepted | `MAGINALIA_IDE/plan` を全体開発計画の正本にする | toybox discussion を実装指示から分離する |
| D002 | 2026-08-16 | Accepted | 既存3 product repo + toybox を当面 monorepo 化しない | runtime/release/failure domain を独立させる |
| D003 | 2026-08-16 | Accepted | product 間は versioned contract + adapter で接続し、internal module を直接 import しない | OSS拡張性・交換性・独立利用を守る |
| D004 | 2026-08-16 | Accepted | research data の正本は Markdown/YAML/JSON/images/Git | app/database lock-in を避ける |
| D005 | 2026-08-16 | Accepted | backend-minimal policy を採用 | local/GitHub/static/provider direct を優先し、小規模backendは必要時のみ |
| D006 | 2026-08-16 | Accepted | backend は research data の唯一の正本にならない | backend failure からユーザーデータを守る |
| D007 | 2026-08-16 | Accepted | 第一利用者を「PCに詳しくない文系学生・研究者・書き手」とする | installer・UI・用語・error設計の基準にする |
| D008 | 2026-08-16 | Accepted | Normal UI では Git 用語を人文学の作業語彙へ翻訳する | Git知識を利用条件にしない |
| D009 | 2026-08-16 | Superseded by D030 | MAGINALIA Desktop は Code-OSS thin overlay を維持する | ADR 0007で独立Electron Desktopへ変更 |
| D010 | 2026-08-16 | Superseded in part by D030 | MAGINALIA固有機能は同じ extension source から Desktop built-in と VS Code extension の両方へ出す | Desktopは独立Mod APIへ移行。standalone VS Code extension pathは任意のpower-user integrationとして残し得る |
| D011 | 2026-08-16 | Superseded by D030 | UI刷新は extension-first、必要な workbench change のみ小さい core patch + ADR | Desktop UXはCode-OSS workbenchから独立して設計する |
| D012 | 2026-08-16 | Accepted | Quote Capture α1 reference client は現 `miniapp` を優先する | unit分割・client OCR・静的配信との相性が良い |
| D013 | 2026-08-16 | Accepted | Android `APK/` は native reference / legacy path として残す | native知見を捨てず、α1 scopeの二重化を避ける |
| D014 | 2026-08-16 | Accepted | Input α1 は Python 3.12 + PySide6 prototype を活かす | 言語統一より既存価値と境界整理を優先する |
| D015 | 2026-08-16 | Accepted | Input は repository 全体を勝手に読むのではなく explicit Context Bundle だけを受け取る | privacy と責任境界を守る |
| D016 | 2026-08-16 | Accepted | Workspace β1 は local integration / launcher / compatibility layer とする | 巨大な第四アプリ・必須cloud化を避ける |
| D017 | 2026-08-16 | Accepted | 1週間 = 1 Primary Outcome sprint、4週間 = 1 re-planning cycle | Codex token周期と scope control を合わせる |
| D018 | 2026-08-16 | Accepted | α1 は一本の end-to-end value flow、β1 は反復利用・回復・移行を基準にする | feature count で version を決めない |
| D019 | 2026-08-16 | Proposed | Canonical Annotation v1 の exact fields | Week 1 contract audit で既存3形式を比較して確定する |
| D020 | 2026-08-16 | Proposed | miniapp GitHub OAuth thin backend を canonical path に残すか | security/UX/maintenance benefit を Week 3 で評価する |
| D021 | 2026-08-16 | Superseded by D030 | beginner Desktop UI のための Code-OSS core patch inventory | DesktopのCode-OSS core patch自体を不要にする方向へ変更 |
| D022 | 2026-08-16 | Accepted | static public shelf は user-owned GitHub Pages / equivalent static host を基本とする | MAGINALIA serverを不要にし公開物を可搬にする |
| D023 | 2026-08-16 | Accepted | Normal installer は Node/Python/PATH/PowerShell等を利用者へ要求しない | 非技術ユーザーを第一利用者とするため |
| D024 | 2026-08-16 | Accepted | `MAGINALIA Note` / `MAGINALIA Note / Capture` を **MAGINALIA Quote Capture** に改称する | ISBN→撮影→OCR→修正→引用exportという役割を名前だけで説明できるようにする。generic `note` data concept は改称しない |
| D025 | 2026-08-16 | Accepted | `MAGINALIA Writer` を **MAGINALIA Input** に改称する | 日本語入力支援ツールでありエディタではないことを明確化し、editor/writer/agent概念との衝突を避ける |
| D026 | 2026-08-29 | Accepted | Android引用採集とPC reviewerのNormal UIを「本を選ぶ→引用を追加→PCへ送る」「取り込む→確認する→探す→コピーする」に限定する | GitHub・旧ZIP・raw OCR・内部状態は詳細設定へ移し、既存contractと明示的な人手確認を維持する |
| D027 | 2026-09-05 | Accepted | GPT-6 Astra Writing Core benchmark前に現行 `extensions/maginalia` のAlpha 0.1 application layerを破棄し、同じdistribution path上の最小bootstrap scaffoldへ置換する | 旧command/UI/orchestrationはcanonicalではなくGit履歴をarchiveとする。format/spec/overlay等の独立資産は保持し、benchmarkでlegacy救済に推論を消費しない |
| D028 | 2026-09-05 | Accepted | `MAGINALIA_IDE` のactive treeでは「legacy/referenceだから残す」を保存理由にしない | 現行contract・build/distribution・supported workflow・normative docs・現行依存のいずれにも不要なコード/テスト/fixture/依存/生成物/旧文書は削除し、Git履歴を唯一のarchiveとする |
| D029 | 2026-09-08 | Accepted | [ADR 0006](../docs/decisions/0006-private-repository-core.md) に基づき、Writing Coreの下に非公開Project / Workbench / Private Shelfと明示的Sync・History・別コピー復元を追加する | 可搬ファイルとTextDocumentの権威を維持する。拡張のGit実装・認証はADR 0004のCLI前提を更新し、公開・破壊的同期を追加しない。実装受入は検証結果と区別する |
| D030 | 2026-09-12 | Accepted | [ADR 0007](../docs/decisions/0007-ai-native-electron-workspace.md) に基づき、MAGINALIA DesktopをCode-OSS overlayから独立したElectron + Monaco系workspaceへ転換し、AI-readableなMod APIを拡張境界とする | Normal UXを一般目的IDEから切り離す。VS Code/Obsidian community assetsはhost runtimeとして裏で走らせず、許諾されたsourceをAIがfork/portできるupstream資産として扱う。AIなしでもCoreは完全に利用可能とする |

---

# How to add a decision

Small/reversible:

```text
Dxxx | date | Accepted | one sentence | consequence
```

ADR required when changing:

- portable data/source of truth
- format compatibility
- auth/security boundary
- backend role
- Code-OSS patch
- repository topology
- public/private publication boundary
- license
- cross-product contract ownership

---

# Superseding decisions

決定を消さない。

新しい行を追加し、旧 decision を `Superseded by Dxxx` にする。

Git history だけに理由を埋めず、この台帳から辿れるようにします。
