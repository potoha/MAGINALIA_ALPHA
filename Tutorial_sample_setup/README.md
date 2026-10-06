# Tutorial sample setup

MAGINALIA first-run onboarding / installer 用のサンプルデータ一式です。

これはセットアップ元データであり、runtime の第二の正本ではありません。実装時は現行の MAGINALIA contract を使って非破壊に materialize してください。

## 内容

- `SETUP_FLOW.md` — Workdesk / Private Shelf / Public Shelf / Tutorial の初回導線
- `installer-copy-manifest.json` — installer が扱う元データのmanifest
- `project-template/` — マキナが残したチュートリアルProject
- `private-shelf-seed/` — 青空文庫由来の Book 3件 + Quote 3件
- `resources/` — 宮沢賢治のPD写真と出典情報

## Materialization rules

- Tutorial Project の Repository UUID / Project ULID はインストール時に新規生成する。
- 既存 Workdesk / Project / Private Shelf / Public Shelf / research file を上書きしない。
- Private Shelf seed は冪等に追加する。
- 同じ Annotation ID が別内容で存在した場合は上書きせず、そのseed itemだけ停止する。
- 同じISBNのBookが既にある場合は既存Bookを優先する。
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
