# MAGINALIA desktop α1 — Before Kaldi

[English README](README_en.md)

**MAGINALIA** は、人文学のためのローカルファーストな研究・執筆ワークスペースです。
このリポジトリは、独立した **Electron + Monaco** デスクトップアプリケーションの現行実装ラインです。

> **状況:** α1 開発中。Windows インストーラーの実機受け入れ確認前です。

MAGINALIA は、学生・研究者・書き手が、Gitやターミナル、汎用プログラミングIDEを理解しなくても、資料や引用を集め、書き、レンダリングし、成果を保存できることを目指しています。

## 現在あるもの

現在のα1開発版には、以下の実動基盤が含まれています。

- Workdesk / Project のナビゲーションと Registry 閲覧
- 複数Markdown文書のタブ表示
- Monacoベースの編集
- 必須のローカルAutosaveとローカル永続化
- Shelf検索と構造化された引用挿入
- Reviewerで承認した引用のcanonical Private Shelfへの反映
- ISBN付き書籍に限定されない汎用Source参照
- 参考文献の自動解決
- 縦書きを含むリッチなMarkdownレンダリング
- 参照解決済みMarkdown・PDF・DOCXのエクスポート
- Project / Workdesk / Private ShelfのローカルGit-backed History
- 共通コマンド基盤とCommand Palette
- 小規模なファイルシステムベースのModホストとfirst-party Modの実験
- ホスト非依存のFormat / Repository / Source / Writing coreパッケージ

このリポジトリはα1の開発用ソースです。Windowsインストーラー、初回設定、対応環境での受け入れ確認を進めています。インターフェース、Mod API、UX、保存ワークフローは変更される可能性があります。

## 基本原則

1. **Local first.** ネットワークサービスが利用できない場合でも、通常のローカルファイルは引き続き利用できること。
2. **Portable research data.** Markdown、YAML、JSON、画像、Gitベースの履歴を永続的な形式とすること。ElectronとMonacoは実装詳細にすぎません。
3. **Autosave is baseline safety.** 手動Saveを儀式として要求せず、編集内容はローカルへ保存されます。AutosaveはGit履歴やリモート同期とは別のものです。
4. **Humanities UX first.** 通常UIでは、実装上の専門用語を必要以上に露出させず、研究・執筆の作業として表現します。
5. **Simple outside, explicit inside.** 外部サービスや専門ツールは、境界の明確なadapterや交換可能なcapabilityの背後に置きます。
6. **AI is optional.** AI providerがなくてもMAGINALIAは有用でなければなりません。
7. **Mods are capabilities, not ambient privilege.** Projectの内容はデータであり、実行可能コードではありません。

## リポジトリ構成

```text
MAGINALIA_ALPHA/
├─ apps/desktop/            # Electronデスクトップアプリケーション
├─ packages/format/         # portable format contracts
├─ packages/repository-core/
├─ packages/source-core/
├─ packages/writing-core/
├─ spec/                    # portable format schemaの正本
├─ sidecars/reviewer/       # Python / FastAPI Reviewer
├─ mods/                    # first-party / 開発用Mods
├─ docs/                    # 維持対象の実装・contractガイド
├─ memory/                  # 検索型の開発コンテキスト
├─ package.json
└─ package-lock.json
```

## 開発

このリポジトリはnpm workspaceです。

```bash
npm ci
npm run typecheck
npm run build
npm test
npm start
```

主なsmoke test:

```bash
npm run smoke
npm run smoke:writing
npm run smoke:workspace
npm run smoke:quotation
npm run smoke:repository
npm run smoke:shelf
npm run smoke:export
```

依存関係の正確なバージョンについては、`package-lock.json` と各package manifestを正本としてください。

## アーキテクチャを変更する前に読むもの

- [`AGENTS.md`](AGENTS.md) — repository workflow、invariant、source authority
- [MAGINALIA_IDE Decision Log](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/09_DECISION_LOG.md) — product横断のcanonical decision
- [MAGINALIA_IDE Alpha Close Sequence](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/27_ALPHA_CLOSE_SLICE_SEQUENCE.md) — canonicalなalpha close計画

プロダクト横断のdecision、ADR、計画の正本は `potoha/MAGINALIA_IDE` にあります。依存関係の正本は各package manifestと `package-lock.json` です。古い実装とAccepted decisionが食い違う場合は、Accepted decisionを優先します。

## Salvage元

`MAGINALIA_ALPHA` が実装先です。明示的な指示がない限り、旧リポジトリは新しいBefore Kaldi実装を追加する場所ではなく、証拠・salvage元として扱います。

- `potoha/MAGINALIA_IDE` — canonical decision、contract、Writing Core / Repository Coreの履歴
- `potoha/MY_marginallia` — Quote Capture / Reviewerの実装とcontract
- `potoha/Uttate-writer` — MAGINALIA Inputの旧実装
- `potoha/toybox` — 過去の設計文脈。MAGINALIA Workspaceプロジェクトからはread-only

## 現在の安全境界

ProductionのGit/GitHub認証、discovery、fetch、push、provisioning、restoreはD032により凍結されています。ローカルGit-backed Historyは引き続きサポートします。Autosaveとローカル永続化はremote-sync gateとは独立しています。

クラウド接続がなくてもローカル執筆は利用可能でなければならず、credentialをportableな研究リポジトリへ保存してはいけません。

## ライセンス / 配布

**beyond the Word. / MAGINALIA PROJECT** が権利を持つ MAGINALIA_ALPHA のコードは、個別のファイルやコンポーネントに別の記載がない限り [MIT License](LICENSE) で公開します。

**MAGINALIA** の名称、ワードマーク、ロゴ、ビジュアルアイデンティティその他のプロジェクト／製品ブランドは、MIT License の許諾対象には含まれません。詳細は [NOTICE](NOTICE) を参照してください。

third-party component はそれぞれのライセンスに従います。また、MAGINALIAで作成・編集・保存・処理された原稿、ノート、引用、画像、Projectデータその他のユーザー作成コンテンツに、このソフトウェアライセンスが自動的に適用されることはありません。

このリポジトリは公開インストーラーではありません。Windows環境でのインストール、更新、アンインストールの受け入れ確認はこれからです。
