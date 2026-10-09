# Tutorial sample setup

MAGINALIA first-run onboarding / installer 用のサンプルデータ一式です。

これはセットアップ元データであり、runtime の第二の正本ではありません。実装時は現行の MAGINALIA contract を使って非破壊に materialize してください。

## 内容

- `SETUP_FLOW.md` — Workdesk / Private Shelf / Public Shelf / Tutorial の初回導線
- `installer-copy-manifest.json` — installer が扱う元データのmanifest
- `project-template/` — マキナが残したチュートリアルProject
- `private-shelf-seed/` — 青空文庫由来の Book 3件 + Quote 3件
- `resources/` — 宮沢賢治のPD写真と出典情報
- typed marker placeholders: `project-template/project.magi.template` and `private-shelf-seed/shelf.magi.template`

## Materialization rules

- Tutorial Projectごとに新しいProject UUIDを1つ生成し、Repository Core `templateFiles()` でtyped `project.magi` とFormat `project.json`を同じidentityから生成する。marker parentは選択中Workdesk markerのUUIDにする。
- Tutorial ProjectのFormat Project IDを別のULID生成処理で作らない。.maginalia/repository.jsonは競合するportable identityなので生成しない。
- Private Shelf markerは新規Shelf作成時だけRepository Coreから `shelf.magi` として生成する。既存Shelfへのseed適用は既存markerと `library.json` を保持する。
- 既存 Workdesk / Project / Private Shelf / Public Shelf / research file を上書きしない。
- Private Shelf seed は冪等に追加する。
- 同じIDで内容が異なるBook / Annotationが存在した場合は明示的conflictとし、上書きしない。
- 同じID・内容のseed recordと一致するBookは既存recordを保持する。
- `library.json`、Book、AnnotationのShelf contractはfolder identityと別に維持し、seed適用はShelf v0.4 migrationを行わない。
- Public Shelfは存在すれば認識するが、初回セットアップのために自動作成・公開しない。
- Windowsでは実際の Downloads Known Folder を解決し、`%USERPROFILE%\\Downloads` を決め打ちしない。
- Linuxでは `XDG_DOWNLOAD_DIR` を解決する。

## Tutorial path

```text
install / first launch
↓
Primary Workdesk を選ぶ / 作る
↓
Private Shelf を選ぶ / 作る
↓
Public Shelf があれば認識
↓
sample Quote 3件をPrivate Shelfへ追加
↓
Tutorial Projectを生成
↓
宮沢賢治.jpgをDownloadsへ配置
↓
sample-aを開く
↓
Shelf検索 → QuoteRef挿入
↓
Downloadsから画像DnD
↓
sample-cの変更をsample-bのSynced Blockで確認
↓
Export Markdown
↓
Export PDF
↓
Export DOCX
↓
Downloadsで成果物確認
↓
完了
```
