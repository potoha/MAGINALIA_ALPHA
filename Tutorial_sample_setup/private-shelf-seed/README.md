# Private Shelf tutorial seed

初回オンボーディング用の小さなPublic Domain引用セットです。

このseedは現行MAGINALIA Format v0.1のBook / Annotation形状です。D063の延期方針に従い、v0.4への移行は行いません。

| Annotation | Work | Book ISBN |
|---|---|---|
| `ann:01JABCDEFGHJKMNPQRSTVWXYZ0` | 宮沢賢治「春と修羅」 | `9784480020024` |
| `ann:01JABCDEFGHJKMNPQRSTVWXYZ1` | 宮沢賢治「銀河鉄道の夜」 | `9784101092058` |
| `ann:01JABCDEFGHJKMNPQRSTVWXYZ2` | 三木清「如何に読書すべきか」 | `9784101019031` |

ページ番号は意図的に省略し、青空文庫図書カード/節を `location.path` に保持します。

`shelf.magi.template` は新規Private Shelf作成時のfolder identity modelです。実際の `shelf.magi` は新しいShelf UUIDからRepository Core `templateFiles()` で生成します。Shelf identityは `library.json`、Book、Annotation、引用元ファイルの代わりにはなりません。

既存Private Shelfへ追加するときは:

- 既存の `shelf.magi` と `library.json` を保持し、seed適用を理由に生成・置換しない
- 欠けているseed entityだけを現行Shelf contract経由で追加
- IDと内容が一致する既存Books / Annotationsはそのまま保持
- 同じIDで内容が異なるrecordは明示的conflictとして扱い、上書きしない
