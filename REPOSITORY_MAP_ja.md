# MAGINALIA_ALPHA — フォルダ構造とファイル一覧

- 基準: `main` @ `5f07244cc398218ea1a214e314656a67fbcebe18`
- 対象: 基準 commit で Git 管理されている 483 ファイル（バイナリを含む）。このマップ自身は基準時点の一覧に含めていません。
- 用途: ディレクトリ構成の把握と、各ファイルの内容を推測するための短い案内。
- 注記: captions はファイル名と配置場所から付けた概要です。正確な仕様は各ファイル本文を参照してください。

## 構造マップ

```text
MAGINALIA_ALPHA/  （ルート直下 11 ファイル）
├── apps/  （287 files）— アプリケーション
│   └── desktop/  （287 files）— Electron Desktop アプリ
│       ├── src/  （267 files）— Main・Preload・Renderer の実装
│       │   └── renderer/  （94 files）— 編集画面、プレビュー、コマンドなどの Renderer 実装
│       └── test/  （15 files）— Desktop の統合・スモーク確認スクリプト
├── docs/  （5 files）— 実装ハンドオフとコア設計資料
│   └── decisions/  （3 files）— 採択済みの設計判断
├── legacy_quates/  （24 files）— 旧形式 Quote Capture の保存データ（旧綴り）
│   └── imports/  （24 files）— 旧形式インポート単位
│       ├── 81606452-c83e-49c9-9663-0777f6d59526/  （3 files）— 旧 Quote Capture の import bundle
│       │   ├── captures/  （1 files）— Quote Capture JSON
│       │   └── images/  （1 files）— 取り込み画像
│       └── f10e2b00-d32b-4c6f-928d-acaa91d6aff8/  （21 files）— 旧 Quote Capture の import bundle
│           ├── captures/  （11 files）— Quote Capture JSON
│           └── images/  （9 files）— 取り込み画像
├── legacy_quotes/  （24 files）— 旧形式 Quote Capture の保存データ
│   └── imports/  （24 files）— 旧形式インポート単位
│       ├── 81606452-c83e-49c9-9663-0777f6d59526/  （3 files）— 旧 Quote Capture の import bundle
│       │   ├── captures/  （1 files）— Quote Capture JSON
│       │   └── images/  （1 files）— 取り込み画像
│       └── f10e2b00-d32b-4c6f-928d-acaa91d6aff8/  （21 files）— 旧 Quote Capture の import bundle
│           ├── captures/  （11 files）— Quote Capture JSON
│           └── images/  （9 files）— 取り込み画像
├── memory/  （11 files）— 検索型プロジェクトメモリ
│   └── records/  （8 files）— トピック別メモリ記録
├── mods/  （3 files）— 拡張 Mod
│   └── dev.maginalia.secondary-markdown/  （3 files）— Secondary Markdown Mod
│       └── dist/  （1 files）— Mod の配布用ビルド
├── packages/  （51 files）— 共有 TypeScript パッケージ
│   ├── format/  （19 files）— 持ち運び可能なデータ形式と schema
│   │   ├── dist/  （13 files）— ビルド成果物
│   │   │   └── schemas/  （10 files）— JSON Schema 群
│   │   ├── scripts/  （1 files）— 補助スクリプト
│   │   └── src/  （2 files）— ソースコード
│   │       └── test/  （1 files）— テスト・確認コード
│   ├── repository-core/  （16 files）— リポジトリ領域の共通ドメイン処理
│   │   ├── dist/  （9 files）— ビルド成果物
│   │   └── src/  （4 files）— ソースコード
│   ├── source-core/  （8 files）— 情報源データの共通処理
│   │   ├── dist/  （3 files）— ビルド成果物
│   │   └── src/  （2 files）— ソースコード
│   └── writing-core/  （8 files）— 執筆データの共通処理
│       ├── dist/  （3 files）— ビルド成果物
│       └── src/  （2 files）— ソースコード
├── plan/  （31 files）— 製品・設計・開発計画
│   ├── benchmarks/  （6 files）— 設計・検証用ベンチマーク資料
│   ├── sprints/  （2 files）— スプリント計画
│   ├── templates/  （3 files）— 計画書テンプレート
│   └── work-packets/  （1 files）— 作業依頼・作業パケット
├── sidecars/  （26 files）— 分離プロセス連携
│   ├── contracts/  （7 files）— プロセス間の versioned contract
│   │   └── fixtures/  （4 files）— contract の正常・異常 fixture
│   └── reviewer/  （19 files）— Python Reviewer sidecar
│       ├── src/  （11 files）— Reviewer の Python 実装
│       │   └── marginalia_reviewer/  （11 files）— Reviewer のアプリ、OCR、DB、候補処理
│       └── tests/  （4 files）— Reviewer sidecar のテスト
└── spec/  （10 files）— 共有データ形式の JSON Schema
```

## ローカルの除外物

以下はこの checkout に存在する、ソース一覧の対象外のものです。最初の 3 項目はルート `.gitignore` で除外されます。構造マップとファイル一覧には含めていません。

- `node_modules/` — npm の依存パッケージ（gitignore）
- `.pytest_cache/` — pytest の cache（gitignore）
- `.pytest-tmp/` — pytest の一時ファイル（gitignore）
- `.git/` — Git 管理データ（Git metadata）

## ファイル一覧

ファイル一覧は基準 commit のパスをすべて掲載しています。

### ルート直下（11 files）

| File | Caption |
|---|---|
| `.gitignore` | Git で追跡しない生成物・ローカルデータの規則 |
| `AGENTS.md` | リポジトリ作業時の指示と制約 |
| `LICENSE` | ライセンス本文 |
| `NOTICE` | 著作権・第三者ソフトウェアの通知 |
| `package-lock.json` | npm 依存関係の固定 lockfile |
| `package-lock.task-backup.json` | 作業用に保存された lockfile backup |
| `package.json` | パッケージ設定、依存関係、実行 scripts |
| `README_ja.md` | プロジェクト概要と利用・開発案内 |
| `readme-first.md` | 最初に読む導入資料 |
| `README.md` | プロジェクト概要と利用・開発案内 |
| `requirements.yaml` | Python 側の依存・実行要件 |

### apps（287 files）

| File | Caption |
|---|---|
| `apps/desktop/package.json` | パッケージ設定、依存関係、実行 scripts |
| `apps/desktop/src/autosave-ipc.ts` | autosave ipc — IPC boundary / main process handler |
| `apps/desktop/src/autosave-shutdown.test.ts` | autosave shutdown の自動テスト |
| `apps/desktop/src/autosave-shutdown.ts` | autosave shutdown — feature module |
| `apps/desktop/src/configured-private-shelf.test.ts` | configured private shelf の自動テスト |
| `apps/desktop/src/configured-private-shelf.ts` | configured private shelf — feature module |
| `apps/desktop/src/d5-smoke.ts` | d5 の smoke runner |
| `apps/desktop/src/desktop-configuration.test.ts` | desktop configuration の自動テスト |
| `apps/desktop/src/desktop-configuration.ts` | desktop configuration — configuration module |
| `apps/desktop/src/document-workspace-ipc.test.ts` | document workspace ipc の自動テスト |
| `apps/desktop/src/document-workspace-ipc.ts` | document workspace ipc — IPC boundary / main process handler |
| `apps/desktop/src/document-workspace.test.ts` | document workspace の自動テスト |
| `apps/desktop/src/document-workspace.ts` | document workspace — feature module |
| `apps/desktop/src/export-artifact-transaction.ts` | export artifact transaction — feature module |
| `apps/desktop/src/export-contract.ts` | export contract — feature module |
| `apps/desktop/src/export-docx.test.ts` | export docx の自動テスト |
| `apps/desktop/src/export-docx.ts` | export docx — feature module |
| `apps/desktop/src/export-ipc.test.ts` | export ipc の自動テスト |
| `apps/desktop/src/export-ipc.ts` | export ipc — IPC boundary / main process handler |
| `apps/desktop/src/export-pdf.test.ts` | export pdf の自動テスト |
| `apps/desktop/src/export-pdf.ts` | export pdf — feature module |
| `apps/desktop/src/export-presentation-settings.test.ts` | export presentation settings の自動テスト |
| `apps/desktop/src/export-presentation-settings.ts` | export presentation settings — feature module |
| `apps/desktop/src/export-smoke.ts` | export の smoke runner |
| `apps/desktop/src/g-smoke.ts` | g の smoke runner |
| `apps/desktop/src/h-smoke.ts` | h の smoke runner |
| `apps/desktop/src/h5-smoke.ts` | h5 の smoke runner |
| `apps/desktop/src/h6r2-canonical-persistence.test.ts` | h6r2 canonical persistence の自動テスト |
| `apps/desktop/src/legacy-quotes-bootstrap-cli.ts` | legacy quotes bootstrap cli — command line helper |
| `apps/desktop/src/legacy-quotes-bootstrap.test.ts` | legacy quotes bootstrap の自動テスト |
| `apps/desktop/src/legacy-quotes-bootstrap.ts` | legacy quotes bootstrap — feature module |
| `apps/desktop/src/legacy-quotes-reader.py` | legacy quotes reader — data reader |
| `apps/desktop/src/library-ipc.test.ts` | library ipc の自動テスト |
| `apps/desktop/src/library-ipc.ts` | library ipc — IPC boundary / main process handler |
| `apps/desktop/src/library-search.test.ts` | library search の自動テスト |
| `apps/desktop/src/library-service.test.ts` | library service の自動テスト |
| `apps/desktop/src/library-service.ts` | library service — domain service |
| `apps/desktop/src/main.ts` | Electron main process の起動・配線 |
| `apps/desktop/src/markdown-file-service.test.ts` | markdown file service の自動テスト |
| `apps/desktop/src/markdown-file-service.ts` | markdown file service — domain service |
| `apps/desktop/src/markdown-ipc.ts` | markdown ipc — IPC boundary / main process handler |
| `apps/desktop/src/mod-bootstrap.test.ts` | mod bootstrap の自動テスト |
| `apps/desktop/src/mod-bootstrap.ts` | mod bootstrap — feature module |
| `apps/desktop/src/mod-host.test.ts` | mod host の自動テスト |
| `apps/desktop/src/mod-host.ts` | mod host — feature module |
| `apps/desktop/src/mod-ipc.test.ts` | mod ipc の自動テスト |
| `apps/desktop/src/mod-ipc.ts` | mod ipc — IPC boundary / main process handler |
| `apps/desktop/src/openbd-metadata.test.ts` | openbd metadata の自動テスト |
| `apps/desktop/src/openbd-metadata.ts` | openbd metadata — feature module |
| `apps/desktop/src/preload-api.test.ts` | preload api の自動テスト |
| `apps/desktop/src/preload-api.ts` | preload api — feature module |
| `apps/desktop/src/preload.ts` | 安全な preload bridge |
| `apps/desktop/src/project-assets-ipc.test.ts` | project assets ipc の自動テスト |
| `apps/desktop/src/project-assets-ipc.ts` | project assets ipc — IPC boundary / main process handler |
| `apps/desktop/src/project-assets.test.ts` | project assets の自動テスト |
| `apps/desktop/src/project-assets.ts` | project assets — feature module |
| `apps/desktop/src/project-ipc.test.ts` | project ipc の自動テスト |
| `apps/desktop/src/project-ipc.ts` | project ipc — IPC boundary / main process handler |
| `apps/desktop/src/project-link-ipc.test.ts` | project link ipc の自動テスト |
| `apps/desktop/src/project-link-ipc.ts` | project link ipc — IPC boundary / main process handler |
| `apps/desktop/src/project-links.test.ts` | project links の自動テスト |
| `apps/desktop/src/project-links.ts` | project links — feature module |
| `apps/desktop/src/project-metadata.test.ts` | project metadata の自動テスト |
| `apps/desktop/src/project-metadata.ts` | project metadata — feature module |
| `apps/desktop/src/project-search-ipc.test.ts` | project search ipc の自動テスト |
| `apps/desktop/src/project-search-ipc.ts` | project search ipc — IPC boundary / main process handler |
| `apps/desktop/src/project-service.test.ts` | project service の自動テスト |
| `apps/desktop/src/project-service.ts` | project service — domain service |
| `apps/desktop/src/project-smoke.ts` | project の smoke runner |
| `apps/desktop/src/quotation-smoke.ts` | quotation の smoke runner |
| `apps/desktop/src/reference-ipc.test.ts` | reference ipc の自動テスト |
| `apps/desktop/src/reference-ipc.ts` | reference ipc — IPC boundary / main process handler |
| `apps/desktop/src/renderer/api.d.ts` | Renderer/API の型宣言 |
| `apps/desktop/src/renderer/autosave-coordinator.test.ts` | autosave coordinator の自動テスト |
| `apps/desktop/src/renderer/autosave-coordinator.ts` | autosave coordinator — workflow coordinator |
| `apps/desktop/src/renderer/cloud-discovery-controller.test.ts` | cloud discovery controller の自動テスト |
| `apps/desktop/src/renderer/cloud-discovery-controller.ts` | cloud discovery controller — renderer interaction controller |
| `apps/desktop/src/renderer/command-context.test.ts` | command context の自動テスト |
| `apps/desktop/src/renderer/command-context.ts` | command context — feature module |
| `apps/desktop/src/renderer/command-palette.ts` | command palette — feature module |
| `apps/desktop/src/renderer/command-registry.test.ts` | command registry の自動テスト |
| `apps/desktop/src/renderer/command-registry.ts` | command registry — command / metadata registry |
| `apps/desktop/src/renderer/context-menu-registry.test.ts` | context menu registry の自動テスト |
| `apps/desktop/src/renderer/context-menu-registry.ts` | context menu registry — command / metadata registry |
| `apps/desktop/src/renderer/context-menu-surface.ts` | context menu surface — feature module |
| `apps/desktop/src/renderer/controller.test.ts` | controller の自動テスト |
| `apps/desktop/src/renderer/controller.ts` | controller — feature module |
| `apps/desktop/src/renderer/core-commands.test.ts` | core commands の自動テスト |
| `apps/desktop/src/renderer/core-commands.ts` | core commands — user command implementation |
| `apps/desktop/src/renderer/dirty-decision.test.ts` | dirty decision の自動テスト |
| `apps/desktop/src/renderer/dirty-decision.ts` | dirty decision — feature module |
| `apps/desktop/src/renderer/document-properties.test.ts` | document properties の自動テスト |
| `apps/desktop/src/renderer/document-properties.ts` | document properties — feature module |
| `apps/desktop/src/renderer/document-session.ts` | document session — feature module |
| `apps/desktop/src/renderer/document-sessions.test.ts` | document sessions の自動テスト |
| `apps/desktop/src/renderer/document-sessions.ts` | document sessions — feature module |
| `apps/desktop/src/renderer/dropped-image.test.ts` | dropped image の自動テスト |
| `apps/desktop/src/renderer/dropped-image.ts` | dropped image — feature module |
| `apps/desktop/src/renderer/embed-providers.test.ts` | embed providers の自動テスト |
| `apps/desktop/src/renderer/embed-providers.ts` | embed providers — feature module |
| `apps/desktop/src/renderer/export-controller.test.ts` | export controller の自動テスト |
| `apps/desktop/src/renderer/export-controller.ts` | export controller — renderer interaction controller |
| `apps/desktop/src/renderer/export-document-model.test.ts` | export document model の自動テスト |
| `apps/desktop/src/renderer/export-document-model.ts` | export document model — feature module |
| `apps/desktop/src/renderer/export-renderer.test.ts` | export renderer の自動テスト |
| `apps/desktop/src/renderer/export-renderer.ts` | export renderer — rendering logic |
| `apps/desktop/src/renderer/index.html` | Renderer の HTML entry point |
| `apps/desktop/src/renderer/library-controller.test.ts` | library controller の自動テスト |
| `apps/desktop/src/renderer/library-controller.ts` | library controller — renderer interaction controller |
| `apps/desktop/src/renderer/main.ts` | Renderer の起動・画面配線 |
| `apps/desktop/src/renderer/markdown-commands.test.ts` | markdown commands の自動テスト |
| `apps/desktop/src/renderer/markdown-commands.ts` | markdown commands — user command implementation |
| `apps/desktop/src/renderer/markdown-fence.ts` | markdown fence — feature module |
| `apps/desktop/src/renderer/markdown-inline.ts` | markdown inline — feature module |
| `apps/desktop/src/renderer/markdown-renderer.test.ts` | markdown renderer の自動テスト |
| `apps/desktop/src/renderer/markdown-renderer.ts` | markdown renderer — rendering logic |
| `apps/desktop/src/renderer/markdown-structure.ts` | markdown structure — feature module |
| `apps/desktop/src/renderer/markdown-table-commands.test.ts` | markdown table commands の自動テスト |
| `apps/desktop/src/renderer/markdown-table-commands.ts` | markdown table commands — user command implementation |
| `apps/desktop/src/renderer/mod-contribution-bridge.test.ts` | mod contribution bridge の自動テスト |
| `apps/desktop/src/renderer/mod-contribution-bridge.ts` | mod contribution bridge — integration bridge |
| `apps/desktop/src/renderer/mod-controller.test.ts` | mod controller の自動テスト |
| `apps/desktop/src/renderer/mod-controller.ts` | mod controller — renderer interaction controller |
| `apps/desktop/src/renderer/monaco-surface.ts` | monaco surface — feature module |
| `apps/desktop/src/renderer/preview-controller.test.ts` | preview controller の自動テスト |
| `apps/desktop/src/renderer/preview-controller.ts` | preview controller — renderer interaction controller |
| `apps/desktop/src/renderer/preview-editing.test.ts` | preview editing の自動テスト |
| `apps/desktop/src/renderer/preview-editing.ts` | preview editing — feature module |
| `apps/desktop/src/renderer/preview-links.test.ts` | preview links の自動テスト |
| `apps/desktop/src/renderer/preview-links.ts` | preview links — feature module |
| `apps/desktop/src/renderer/project-controller.test.ts` | project controller の自動テスト |
| `apps/desktop/src/renderer/project-controller.ts` | project controller — renderer interaction controller |
| `apps/desktop/src/renderer/project-media.ts` | project media — feature module |
| `apps/desktop/src/renderer/project-ui.test.ts` | project ui の自動テスト |
| `apps/desktop/src/renderer/project-ui.ts` | project ui — feature module |
| `apps/desktop/src/renderer/properties-target.test.ts` | properties target の自動テスト |
| `apps/desktop/src/renderer/properties-target.ts` | properties target — feature module |
| `apps/desktop/src/renderer/reference-list.test.ts` | reference list の自動テスト |
| `apps/desktop/src/renderer/reference-list.ts` | reference list — feature module |
| `apps/desktop/src/renderer/references-controller.test.ts` | references controller の自動テスト |
| `apps/desktop/src/renderer/references-controller.ts` | references controller — renderer interaction controller |
| `apps/desktop/src/renderer/renderer-preferences.test.ts` | renderer preferences の自動テスト |
| `apps/desktop/src/renderer/renderer-preferences.ts` | renderer preferences — feature module |
| `apps/desktop/src/renderer/repository-controller.test.ts` | repository controller の自動テスト |
| `apps/desktop/src/renderer/repository-controller.ts` | repository controller — renderer interaction controller |
| `apps/desktop/src/renderer/security.test.ts` | security の自動テスト |
| `apps/desktop/src/renderer/shelf-controller.test.ts` | shelf controller の自動テスト |
| `apps/desktop/src/renderer/shelf-controller.ts` | shelf controller — renderer interaction controller |
| `apps/desktop/src/renderer/style.css` | Renderer の画面スタイル |
| `apps/desktop/src/renderer/synced-block-export.test.ts` | synced block export の自動テスト |
| `apps/desktop/src/renderer/synced-block.test.ts` | synced block の自動テスト |
| `apps/desktop/src/renderer/synced-block.ts` | synced block — feature module |
| `apps/desktop/src/renderer/table-target.test.ts` | table target の自動テスト |
| `apps/desktop/src/renderer/table-target.ts` | table target — feature module |
| `apps/desktop/src/renderer/unified-search.test.ts` | unified search の自動テスト |
| `apps/desktop/src/renderer/unified-search.ts` | unified search — search and query logic |
| `apps/desktop/src/renderer/utility-bar.ts` | utility bar — feature module |
| `apps/desktop/src/renderer/vite-env.d.ts` | Renderer/API の型宣言 |
| `apps/desktop/src/renderer/workbench-commands.test.ts` | workbench commands の自動テスト |
| `apps/desktop/src/renderer/workbench-commands.ts` | workbench commands — user command implementation |
| `apps/desktop/src/renderer/workbench-core.test.ts` | workbench core の自動テスト |
| `apps/desktop/src/renderer/workbench-core.ts` | workbench core — feature module |
| `apps/desktop/src/renderer/workbench-views.test.ts` | workbench views の自動テスト |
| `apps/desktop/src/renderer/workbench-views.ts` | workbench views — feature module |
| `apps/desktop/src/renderer/workspace-controller.test.ts` | workspace controller の自動テスト |
| `apps/desktop/src/renderer/workspace-controller.ts` | workspace controller — renderer interaction controller |
| `apps/desktop/src/repository-cloud-config.test.ts` | repository cloud config の自動テスト |
| `apps/desktop/src/repository-cloud-config.ts` | repository cloud config — configuration module |
| `apps/desktop/src/repository-cloud-connection-store.test.ts` | repository cloud connection store の自動テスト |
| `apps/desktop/src/repository-cloud-connection-store.ts` | repository cloud connection store — feature module |
| `apps/desktop/src/repository-cloud-connection.test.ts` | repository cloud connection の自動テスト |
| `apps/desktop/src/repository-cloud-connection.ts` | repository cloud connection — feature module |
| `apps/desktop/src/repository-cloud-coordinator.test.ts` | repository cloud coordinator の自動テスト |
| `apps/desktop/src/repository-cloud-coordinator.ts` | repository cloud coordinator — workflow coordinator |
| `apps/desktop/src/repository-cloud-discover-operation.test.ts` | repository cloud discover operation の自動テスト |
| `apps/desktop/src/repository-cloud-discover-operation.ts` | repository cloud discover operation — feature module |
| `apps/desktop/src/repository-cloud-discovery.test.ts` | repository cloud discovery の自動テスト |
| `apps/desktop/src/repository-cloud-discovery.ts` | repository cloud discovery — feature module |
| `apps/desktop/src/repository-cloud-ipc.test.ts` | repository cloud ipc の自動テスト |
| `apps/desktop/src/repository-cloud-ipc.ts` | repository cloud ipc — IPC boundary / main process handler |
| `apps/desktop/src/repository-cloud-local-preflight.test.ts` | repository cloud local preflight の自動テスト |
| `apps/desktop/src/repository-cloud-local-preflight.ts` | repository cloud local preflight — feature module |
| `apps/desktop/src/repository-cloud-pending.test.ts` | repository cloud pending の自動テスト |
| `apps/desktop/src/repository-cloud-pending.ts` | repository cloud pending — feature module |
| `apps/desktop/src/repository-cloud-provision.test.ts` | repository cloud provision の自動テスト |
| `apps/desktop/src/repository-cloud-provision.ts` | repository cloud provision — feature module |
| `apps/desktop/src/repository-cloud-restore-catalog.test.ts` | repository cloud restore catalog の自動テスト |
| `apps/desktop/src/repository-cloud-restore-catalog.ts` | repository cloud restore catalog — feature module |
| `apps/desktop/src/repository-cloud-sync-classification.test.ts` | repository cloud sync classification の自動テスト |
| `apps/desktop/src/repository-cloud-sync-classification.ts` | repository cloud sync classification — feature module |
| `apps/desktop/src/repository-filesystem.test.ts` | repository filesystem の自動テスト |
| `apps/desktop/src/repository-filesystem.ts` | repository filesystem — feature module |
| `apps/desktop/src/repository-git-classify.test.ts` | repository git classify の自動テスト |
| `apps/desktop/src/repository-git-classify.ts` | repository git classify — feature module |
| `apps/desktop/src/repository-git-confirm.test.ts` | repository git confirm の自動テスト |
| `apps/desktop/src/repository-git-confirm.ts` | repository git confirm — feature module |
| `apps/desktop/src/repository-git-fetch.test.ts` | repository git fetch の自動テスト |
| `apps/desktop/src/repository-git-fetch.ts` | repository git fetch — feature module |
| `apps/desktop/src/repository-git-http.test.ts` | repository git http の自動テスト |
| `apps/desktop/src/repository-git-http.ts` | repository git http — feature module |
| `apps/desktop/src/repository-git-materialize.test.ts` | repository git materialize の自動テスト |
| `apps/desktop/src/repository-git-materialize.ts` | repository git materialize — feature module |
| `apps/desktop/src/repository-git-probe.test.ts` | repository git probe の自動テスト |
| `apps/desktop/src/repository-git-probe.ts` | repository git probe — feature module |
| `apps/desktop/src/repository-git-push.test.ts` | repository git push の自動テスト |
| `apps/desktop/src/repository-git-push.ts` | repository git push — feature module |
| `apps/desktop/src/repository-git-stage.test.ts` | repository git stage の自動テスト |
| `apps/desktop/src/repository-git-stage.ts` | repository git stage — feature module |
| `apps/desktop/src/repository-git-validate.test.ts` | repository git validate の自動テスト |
| `apps/desktop/src/repository-git-validate.ts` | repository git validate — feature module |
| `apps/desktop/src/repository-github-auth.test.ts` | repository github auth の自動テスト |
| `apps/desktop/src/repository-github-auth.ts` | repository github auth — feature module |
| `apps/desktop/src/repository-github.test.ts` | repository github の自動テスト |
| `apps/desktop/src/repository-github.ts` | repository github — feature module |
| `apps/desktop/src/repository-history-service.test.ts` | repository history service の自動テスト |
| `apps/desktop/src/repository-ipc.test.ts` | repository ipc の自動テスト |
| `apps/desktop/src/repository-ipc.ts` | repository ipc — IPC boundary / main process handler |
| `apps/desktop/src/repository-local-history.list.test.ts` | repository local history.list の自動テスト |
| `apps/desktop/src/repository-local-history.materialize.test.ts` | repository local history.materialize の自動テスト |
| `apps/desktop/src/repository-local-history.snapshot.test.ts` | repository local history.snapshot の自動テスト |
| `apps/desktop/src/repository-local-history.test.ts` | repository local history の自動テスト |
| `apps/desktop/src/repository-local-history.ts` | repository local history — feature module |
| `apps/desktop/src/repository-materialization-worker-launcher.test.ts` | repository materialization worker launcher の自動テスト |
| `apps/desktop/src/repository-materialization-worker-launcher.ts` | repository materialization worker launcher — worker process launcher |
| `apps/desktop/src/repository-materialization-worker-smoke.ts` | repository materialization worker の smoke runner |
| `apps/desktop/src/repository-materialization-worker-test-fixture.ts` | repository materialization worker test fixture — feature module |
| `apps/desktop/src/repository-materialization-worker.ts` | repository materialization worker — background worker |
| `apps/desktop/src/repository-service.copy.test.ts` | repository service.copy の自動テスト |
| `apps/desktop/src/repository-service.test.ts` | repository service の自動テスト |
| `apps/desktop/src/repository-service.ts` | repository service — domain service |
| `apps/desktop/src/repository-smoke.ts` | repository の smoke runner |
| `apps/desktop/src/repository-windows-job.test.ts` | repository windows job の自動テスト |
| `apps/desktop/src/repository-windows-job.ts` | repository windows job — feature module |
| `apps/desktop/src/reviewer-embedded-view-host.test.ts` | reviewer embedded view host の自動テスト |
| `apps/desktop/src/reviewer-embedded-view-host.ts` | reviewer embedded view host — feature module |
| `apps/desktop/src/reviewer-ipc.test.ts` | reviewer ipc の自動テスト |
| `apps/desktop/src/reviewer-ipc.ts` | reviewer ipc — IPC boundary / main process handler |
| `apps/desktop/src/reviewer-process-manager.test.ts` | reviewer process manager の自動テスト |
| `apps/desktop/src/reviewer-process-manager.ts` | reviewer process manager — child process manager |
| `apps/desktop/src/reviewer-resolution.test.ts` | reviewer resolution の自動テスト |
| `apps/desktop/src/reviewer-resolution.ts` | reviewer resolution — reference / identity resolution |
| `apps/desktop/src/reviewer-shelf-materializer.ts` | reviewer shelf materializer — feature module |
| `apps/desktop/src/reviewer-shelf-reconciliation.test.ts` | reviewer shelf reconciliation の自動テスト |
| `apps/desktop/src/reviewer-shelf-reconciliation.ts` | reviewer shelf reconciliation — feature module |
| `apps/desktop/src/reviewer-shelf-sync.test.ts` | reviewer shelf sync の自動テスト |
| `apps/desktop/src/reviewer-shelf-sync.ts` | reviewer shelf sync — feature module |
| `apps/desktop/src/reviewer-view-controller.test.ts` | reviewer view controller の自動テスト |
| `apps/desktop/src/reviewer-view-controller.ts` | reviewer view controller — renderer interaction controller |
| `apps/desktop/src/security.ts` | security — feature module |
| `apps/desktop/src/shelf-ipc.test.ts` | shelf ipc の自動テスト |
| `apps/desktop/src/shelf-ipc.ts` | shelf ipc — IPC boundary / main process handler |
| `apps/desktop/src/shelf-location-registry.ts` | shelf location registry — command / metadata registry |
| `apps/desktop/src/shelf-resolution.test.ts` | shelf resolution の自動テスト |
| `apps/desktop/src/shelf-resolution.ts` | shelf resolution — reference / identity resolution |
| `apps/desktop/src/shelf-smoke.ts` | shelf の smoke runner |
| `apps/desktop/src/smoke-mode.test.ts` | smoke mode の自動テスト |
| `apps/desktop/src/smoke-mode.ts` | smoke mode — feature module |
| `apps/desktop/src/synced-block-ipc.test.ts` | synced block ipc の自動テスト |
| `apps/desktop/src/synced-block-ipc.ts` | synced block ipc — IPC boundary / main process handler |
| `apps/desktop/src/workdesk-ipc.test.ts` | workdesk ipc の自動テスト |
| `apps/desktop/src/workdesk-ipc.ts` | workdesk ipc — IPC boundary / main process handler |
| `apps/desktop/src/workdesk-service.test.ts` | workdesk service の自動テスト |
| `apps/desktop/src/workdesk-service.ts` | workdesk service — domain service |
| `apps/desktop/src/workspace-smoke.ts` | workspace の smoke runner |
| `apps/desktop/src/workspace-state-ipc.test.ts` | workspace state ipc の自動テスト |
| `apps/desktop/src/workspace-state-ipc.ts` | workspace state ipc — IPC boundary / main process handler |
| `apps/desktop/src/workspace-state-service.ts` | workspace state service — domain service |
| `apps/desktop/src/writing-smoke.ts` | writing の smoke runner |
| `apps/desktop/test/d5-smoke.mjs` | Desktop の d5 smoke 統合・スモーク確認 |
| `apps/desktop/test/electron-smoke-launcher.mjs` | Desktop の electron smoke launcher 統合・スモーク確認 |
| `apps/desktop/test/electron-smoke.mjs` | Desktop の electron smoke 統合・スモーク確認 |
| `apps/desktop/test/export-smoke.mjs` | Desktop の export smoke 統合・スモーク確認 |
| `apps/desktop/test/g-smoke.mjs` | Desktop の g smoke 統合・スモーク確認 |
| `apps/desktop/test/github-device-preflight.mjs` | Desktop の github device preflight 統合・スモーク確認 |
| `apps/desktop/test/h-smoke.mjs` | Desktop の h smoke 統合・スモーク確認 |
| `apps/desktop/test/h5-smoke.mjs` | Desktop の h5 smoke 統合・スモーク確認 |
| `apps/desktop/test/project-smoke.mjs` | Desktop の project smoke 統合・スモーク確認 |
| `apps/desktop/test/quotation-smoke.mjs` | Desktop の quotation smoke 統合・スモーク確認 |
| `apps/desktop/test/repository-smoke.mjs` | Desktop の repository smoke 統合・スモーク確認 |
| `apps/desktop/test/shelf-smoke.mjs` | Desktop の shelf smoke 統合・スモーク確認 |
| `apps/desktop/test/workbench-ui-smoke.mjs` | Desktop の workbench ui smoke 統合・スモーク確認 |
| `apps/desktop/test/workspace-smoke.mjs` | Desktop の workspace smoke 統合・スモーク確認 |
| `apps/desktop/test/writing-smoke.mjs` | Desktop の writing smoke 統合・スモーク確認 |
| `apps/desktop/tsconfig.json` | Desktop TypeScript compiler 設定 |
| `apps/desktop/tsconfig.main.json` | Desktop TypeScript compiler 設定 |
| `apps/desktop/vite.config.mts` | Vite build/dev 設定 |
| `apps/desktop/vitest.config.mts` | Vitest test-runner 設定 |

### docs（5 files）

| File | Caption |
|---|---|
| `docs/decisions/0001-document-workspace-boundary.md` | 採択済み設計判断 |
| `docs/decisions/0002-quotation-resolution-boundary.md` | 採択済み設計判断 |
| `docs/decisions/0003-private-cloud-boundaries.md` | 採択済み設計判断 |
| `docs/GITHUB_INTEGRATION_HANDOFF.md` | 実装・統合に関するハンドオフ資料 |
| `docs/REPOSITORY_CORE_FREEZE.md` | 実装・統合に関するハンドオフ資料 |

### legacy_quates（24 files）

| File | Caption |
|---|---|
| `legacy_quates/imports/81606452-c83e-49c9-9663-0777f6d59526/captures/c2bd3d18-b90d-4f6e-a2f6-7718676c98e8.json` | 旧形式の Quote Capture 記録 |
| `legacy_quates/imports/81606452-c83e-49c9-9663-0777f6d59526/images/50eaba95-84cb-47ed-8414-18bd1d06a401.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quates/imports/81606452-c83e-49c9-9663-0777f6d59526/manifest.json` | 旧形式インポートの manifest |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/12f2af43-58c9-49c9-a1de-6a27c46e4bb6.json` | 旧形式の Quote Capture 記録 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/3a4b85cd-4ece-4421-897b-36461ddf9c81.json` | 旧形式の Quote Capture 記録 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/4a92f61c-644f-4527-b9f6-7f02dad07766.json` | 旧形式の Quote Capture 記録 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/6727a4b0-84bb-44c3-a3e8-0c7a26da9e07.json` | 旧形式の Quote Capture 記録 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/9cd92c2a-a97b-452a-803a-d12f263c22c7.json` | 旧形式の Quote Capture 記録 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/a59e3245-58e4-49e2-b35b-7fc0eecdf7cb.json` | 旧形式の Quote Capture 記録 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/b55b889f-4d58-48fc-a3de-0912c0ca6e2c.json` | 旧形式の Quote Capture 記録 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/c15b4305-c51c-40db-b57c-c99b4f7f865e.json` | 旧形式の Quote Capture 記録 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/da57c1ec-6e9c-47c6-a794-c06eead3f9e4.json` | 旧形式の Quote Capture 記録 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/e1b74e52-bced-4755-95eb-8ad1e0f144f1.json` | 旧形式の Quote Capture 記録 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/e5a97538-c489-4e7b-adfe-52652f00a76f.json` | 旧形式の Quote Capture 記録 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/0b4e7902-75b0-4a06-babc-d4c181d86adc.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/2c28d227-15f2-4f51-9b91-8adea57eb228.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/83c1c8d4-923f-4c69-b750-f9b9f0839509.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/8bf97bf7-da20-408a-bdc4-46da0ac21a20.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/914f1770-3d3d-42da-a5de-1aa0aa59c517.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/966cf7f8-78fa-4161-9379-0485712ffb29.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/b14d11be-855b-4b61-b5d7-a19cab353cc4.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/bdb51b8a-def5-4922-90f3-afc0a0cc7f89.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/ec7f7acd-e48b-482c-8943-0324ba4cbcdb.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quates/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/manifest.json` | 旧形式インポートの manifest |

### legacy_quotes（24 files）

| File | Caption |
|---|---|
| `legacy_quotes/imports/81606452-c83e-49c9-9663-0777f6d59526/captures/c2bd3d18-b90d-4f6e-a2f6-7718676c98e8.json` | 旧形式の Quote Capture 記録 |
| `legacy_quotes/imports/81606452-c83e-49c9-9663-0777f6d59526/images/50eaba95-84cb-47ed-8414-18bd1d06a401.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quotes/imports/81606452-c83e-49c9-9663-0777f6d59526/manifest.json` | 旧形式インポートの manifest |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/12f2af43-58c9-49c9-a1de-6a27c46e4bb6.json` | 旧形式の Quote Capture 記録 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/3a4b85cd-4ece-4421-897b-36461ddf9c81.json` | 旧形式の Quote Capture 記録 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/4a92f61c-644f-4527-b9f6-7f02dad07766.json` | 旧形式の Quote Capture 記録 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/6727a4b0-84bb-44c3-a3e8-0c7a26da9e07.json` | 旧形式の Quote Capture 記録 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/9cd92c2a-a97b-452a-803a-d12f263c22c7.json` | 旧形式の Quote Capture 記録 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/a59e3245-58e4-49e2-b35b-7fc0eecdf7cb.json` | 旧形式の Quote Capture 記録 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/b55b889f-4d58-48fc-a3de-0912c0ca6e2c.json` | 旧形式の Quote Capture 記録 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/c15b4305-c51c-40db-b57c-c99b4f7f865e.json` | 旧形式の Quote Capture 記録 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/da57c1ec-6e9c-47c6-a794-c06eead3f9e4.json` | 旧形式の Quote Capture 記録 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/e1b74e52-bced-4755-95eb-8ad1e0f144f1.json` | 旧形式の Quote Capture 記録 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/captures/e5a97538-c489-4e7b-adfe-52652f00a76f.json` | 旧形式の Quote Capture 記録 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/0b4e7902-75b0-4a06-babc-d4c181d86adc.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/2c28d227-15f2-4f51-9b91-8adea57eb228.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/83c1c8d4-923f-4c69-b750-f9b9f0839509.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/8bf97bf7-da20-408a-bdc4-46da0ac21a20.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/914f1770-3d3d-42da-a5de-1aa0aa59c517.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/966cf7f8-78fa-4161-9379-0485712ffb29.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/b14d11be-855b-4b61-b5d7-a19cab353cc4.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/bdb51b8a-def5-4922-90f3-afc0a0cc7f89.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/images/ec7f7acd-e48b-482c-8943-0324ba4cbcdb.jpg` | 旧 Quote Capture の原画像 |
| `legacy_quotes/imports/f10e2b00-d32b-4c6f-928d-acaa91d6aff8/manifest.json` | 旧形式インポートの manifest |

### memory（11 files）

| File | Caption |
|---|---|
| `memory/index.json` | メモリ検索の索引・説明 |
| `memory/query.mjs` | 関連メモリを検索する小型 CLI |
| `memory/README.md` | メモリ検索の索引・説明 |
| `memory/records/antigravity-h5-debt.md` | 検索型プロジェクトメモリの記録 |
| `memory/records/core-invariants.md` | 検索型プロジェクトメモリの記録 |
| `memory/records/distribution-roadmap.md` | 検索型プロジェクトメモリの記録 |
| `memory/records/h5-reviewer.md` | 検索型プロジェクトメモリの記録 |
| `memory/records/h6-renderer.md` | 検索型プロジェクトメモリの記録 |
| `memory/records/h7-authoring-freeze.md` | 検索型プロジェクトメモリの記録 |
| `memory/records/opencode-runtime.md` | 検索型プロジェクトメモリの記録 |
| `memory/records/repo-current-state.md` | 検索型プロジェクトメモリの記録 |

### mods（3 files）

| File | Caption |
|---|---|
| `mods/dev.maginalia.secondary-markdown/dist/index.js` | 追跡対象のビルド成果物 |
| `mods/dev.maginalia.secondary-markdown/maginalia.mod.json` | Mod の ID・能力・入口設定 |
| `mods/dev.maginalia.secondary-markdown/package.json` | パッケージ設定、依存関係、実行 scripts |

### packages（51 files）

| File | Caption |
|---|---|
| `packages/format/dist/index.d.ts` | 追跡対象のビルド成果物 |
| `packages/format/dist/index.d.ts.map` | 追跡対象のビルド成果物 |
| `packages/format/dist/index.js` | 追跡対象のビルド成果物 |
| `packages/format/dist/schemas/annotation.schema.json` | データ contract の JSON Schema |
| `packages/format/dist/schemas/book.schema.json` | データ contract の JSON Schema |
| `packages/format/dist/schemas/common.schema.json` | データ contract の JSON Schema |
| `packages/format/dist/schemas/library.schema.json` | データ contract の JSON Schema |
| `packages/format/dist/schemas/note.schema.json` | データ contract の JSON Schema |
| `packages/format/dist/schemas/project.schema.json` | データ contract の JSON Schema |
| `packages/format/dist/schemas/publication.schema.json` | データ contract の JSON Schema |
| `packages/format/dist/schemas/published-annotation.schema.json` | データ contract の JSON Schema |
| `packages/format/dist/schemas/published-book.schema.json` | データ contract の JSON Schema |
| `packages/format/dist/schemas/source.schema.json` | データ contract の JSON Schema |
| `packages/format/package.json` | パッケージ設定、依存関係、実行 scripts |
| `packages/format/scripts/copy-schemas.mjs` | 共有パッケージ補助ファイル |
| `packages/format/src/index.ts` | 共有パッケージの index 実装 |
| `packages/format/src/test/format.test.ts` | 共有パッケージの自動テスト |
| `packages/format/tsconfig.build.json` | TypeScript compiler 設定 |
| `packages/format/tsconfig.json` | TypeScript compiler 設定 |
| `packages/repository-core/dist/domain.d.ts` | 追跡対象のビルド成果物 |
| `packages/repository-core/dist/domain.d.ts.map` | 追跡対象のビルド成果物 |
| `packages/repository-core/dist/domain.js` | 追跡対象のビルド成果物 |
| `packages/repository-core/dist/index.d.ts` | 追跡対象のビルド成果物 |
| `packages/repository-core/dist/index.d.ts.map` | 追跡対象のビルド成果物 |
| `packages/repository-core/dist/index.js` | 追跡対象のビルド成果物 |
| `packages/repository-core/dist/templates.d.ts` | 追跡対象のビルド成果物 |
| `packages/repository-core/dist/templates.d.ts.map` | 追跡対象のビルド成果物 |
| `packages/repository-core/dist/templates.js` | 追跡対象のビルド成果物 |
| `packages/repository-core/package.json` | パッケージ設定、依存関係、実行 scripts |
| `packages/repository-core/src/domain.ts` | 共有パッケージの domain 実装 |
| `packages/repository-core/src/index.test.ts` | 共有パッケージの index.test 実装 |
| `packages/repository-core/src/index.ts` | 共有パッケージの index 実装 |
| `packages/repository-core/src/templates.ts` | 共有パッケージの templates 実装 |
| `packages/repository-core/tsconfig.build.json` | TypeScript compiler 設定 |
| `packages/repository-core/tsconfig.json` | TypeScript compiler 設定 |
| `packages/source-core/dist/index.d.ts` | 追跡対象のビルド成果物 |
| `packages/source-core/dist/index.d.ts.map` | 追跡対象のビルド成果物 |
| `packages/source-core/dist/index.js` | 追跡対象のビルド成果物 |
| `packages/source-core/package.json` | パッケージ設定、依存関係、実行 scripts |
| `packages/source-core/src/index.test.ts` | 共有パッケージの index.test 実装 |
| `packages/source-core/src/index.ts` | 共有パッケージの index 実装 |
| `packages/source-core/tsconfig.build.json` | TypeScript compiler 設定 |
| `packages/source-core/tsconfig.json` | TypeScript compiler 設定 |
| `packages/writing-core/dist/index.d.ts` | 追跡対象のビルド成果物 |
| `packages/writing-core/dist/index.d.ts.map` | 追跡対象のビルド成果物 |
| `packages/writing-core/dist/index.js` | 追跡対象のビルド成果物 |
| `packages/writing-core/package.json` | パッケージ設定、依存関係、実行 scripts |
| `packages/writing-core/src/index.test.ts` | 共有パッケージの index.test 実装 |
| `packages/writing-core/src/index.ts` | 共有パッケージの index 実装 |
| `packages/writing-core/tsconfig.build.json` | TypeScript compiler 設定 |
| `packages/writing-core/tsconfig.json` | TypeScript compiler 設定 |

### plan（31 files）

| File | Caption |
|---|---|
| `plan/00_MANIFESTO.md` | 製品・設計・開発計画 |
| `plan/01_REPOSITORY_AUDIT.md` | 製品・設計・開発計画 |
| `plan/02_ARCHITECTURE.md` | 製品・設計・開発計画 |
| `plan/03_TECH_STACK.md` | 製品・設計・開発計画 |
| `plan/04_PRODUCT_GOALS.md` | 製品・設計・開発計画 |
| `plan/05_DEVELOPMENT_CADENCE.md` | 製品・設計・開発計画 |
| `plan/06_INITIAL_4W_PLAN.md` | 製品・設計・開発計画 |
| `plan/07_FLOWS.md` | 製品・設計・開発計画 |
| `plan/08_QUALITY_AND_TESTING.md` | 製品・設計・開発計画 |
| `plan/09_DECISION_LOG.md` | 製品・設計・開発計画 |
| `plan/10_MAINTENANCE_AND_EXTENSION.md` | 製品・設計・開発計画 |
| `plan/11_UX_PRINCIPLES.md` | 製品・設計・開発計画 |
| `plan/12_DISTRIBUTION_AND_ONBOARDING.md` | 製品・設計・開発計画 |
| `plan/13_MILESTONE_SEQUENCE.md` | 製品・設計・開発計画 |
| `plan/14_RISK_REGISTER.md` | 製品・設計・開発計画 |
| `plan/15_OSS_GOVERNANCE.md` | 製品・設計・開発計画 |
| `plan/16_PRODUCT_NAMING.md` | 製品・設計・開発計画 |
| `plan/17_CAPTURE_REVIEW_UX_SPEC.md` | 製品・設計・開発計画 |
| `plan/benchmarks/2026-09-05_GPT6_ASTRA_MAGINALIA_IDE_BENCHMARK_PROMPT.md` | 設計・検証ベンチマーク資料 |
| `plan/benchmarks/2026-09-11_GPT6_ASTRA_REPOSITORY_CORE_LEAN_PROMPT.md` | 設計・検証ベンチマーク資料 |
| `plan/benchmarks/2026-09-11_GPT6_ASTRA_REPOSITORY_CORE_VERIFICATION_PROMPT.md` | 設計・検証ベンチマーク資料 |
| `plan/benchmarks/2026-09-11_REPOSITORY_CORE_IMPLEMENTATION_HANDOFF.md` | 設計・検証ベンチマーク資料 |
| `plan/benchmarks/2026-09-11_REPOSITORY_CORE_LEAN_BENCH_PIVOT.md` | 設計・検証ベンチマーク資料 |
| `plan/benchmarks/2026-09-11_REPOSITORY_CORE_VERIFICATION_FAIL_HEAD_ATOMICITY.md` | 設計・検証ベンチマーク資料 |
| `plan/README.md` | 製品・設計・開発計画 |
| `plan/sprints/2026-W34.md` | スプリント計画 |
| `plan/sprints/2026-W35.md` | スプリント計画 |
| `plan/templates/FEATURE_SPEC_TEMPLATE.md` | 計画文書テンプレート |
| `plan/templates/MONTHLY_REVIEW_TEMPLATE.md` | 計画文書テンプレート |
| `plan/templates/SPRINT_TEMPLATE.md` | 計画文書テンプレート |
| `plan/work-packets/2026-09-05_PREBENCH_EXTENSION_RESET.md` | 作業パケット |

### sidecars（26 files）

| File | Caption |
|---|---|
| `sidecars/contracts/fixtures/manifest-v1.invalid-version.json` | sidecar contract のテスト fixture |
| `sidecars/contracts/fixtures/manifest-v1.valid.json` | sidecar contract のテスト fixture |
| `sidecars/contracts/fixtures/published-book-v1.invalid-image-leak.json` | sidecar contract のテスト fixture |
| `sidecars/contracts/fixtures/published-book-v1.valid.json` | sidecar contract のテスト fixture |
| `sidecars/contracts/manifest-v1.schema.json` | データ contract の JSON Schema |
| `sidecars/contracts/published-book-v1.schema.json` | データ contract の JSON Schema |
| `sidecars/contracts/README.md` | sidecar 間の versioned contract |
| `sidecars/reviewer/ndlocr-lite-1.2.3.lock.json` | 外部 OCR/runtime の固定バージョン情報 |
| `sidecars/reviewer/pyproject.toml` | Python パッケージ設定と依存関係 |
| `sidecars/reviewer/README.md` | Markdown 資料 |
| `sidecars/reviewer/src/marginalia_reviewer/__init__.py` | Reviewer sidecar の init 処理 |
| `sidecars/reviewer/src/marginalia_reviewer/__main__.py` | Reviewer sidecar の main 処理 |
| `sidecars/reviewer/src/marginalia_reviewer/app.py` | Reviewer sidecar の app 処理 |
| `sidecars/reviewer/src/marginalia_reviewer/candidates.py` | Reviewer sidecar の candidates 処理 |
| `sidecars/reviewer/src/marginalia_reviewer/config.py` | Reviewer sidecar の config 処理 |
| `sidecars/reviewer/src/marginalia_reviewer/db.py` | Reviewer sidecar の db 処理 |
| `sidecars/reviewer/src/marginalia_reviewer/importer.py` | Reviewer sidecar の importer 処理 |
| `sidecars/reviewer/src/marginalia_reviewer/ocr.py` | Reviewer sidecar の ocr 処理 |
| `sidecars/reviewer/src/marginalia_reviewer/publisher.py` | Reviewer sidecar の publisher 処理 |
| `sidecars/reviewer/src/marginalia_reviewer/schema.py` | Reviewer sidecar の schema 処理 |
| `sidecars/reviewer/src/marginalia_reviewer/ui.py` | Reviewer sidecar の ui 処理 |
| `sidecars/reviewer/tests/test_candidates.py` | Reviewer sidecar の自動テスト |
| `sidecars/reviewer/tests/test_magicap.py` | Reviewer sidecar の自動テスト |
| `sidecars/reviewer/tests/test_reviewer.py` | Reviewer sidecar の自動テスト |
| `sidecars/reviewer/tests/test_search.py` | Reviewer sidecar の自動テスト |
| `sidecars/reviewer/uv.lock` | Python 依存関係の固定 lockfile |

### spec（10 files）

| File | Caption |
|---|---|
| `spec/annotation.schema.json` | データ contract の JSON Schema |
| `spec/book.schema.json` | データ contract の JSON Schema |
| `spec/common.schema.json` | データ contract の JSON Schema |
| `spec/library.schema.json` | データ contract の JSON Schema |
| `spec/note.schema.json` | データ contract の JSON Schema |
| `spec/project.schema.json` | データ contract の JSON Schema |
| `spec/publication.schema.json` | データ contract の JSON Schema |
| `spec/published-annotation.schema.json` | データ contract の JSON Schema |
| `spec/published-book.schema.json` | データ contract の JSON Schema |
| `spec/source.schema.json` | データ contract の JSON Schema |

