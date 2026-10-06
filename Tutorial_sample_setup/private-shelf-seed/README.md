# Private Shelf tutorial seed

初回オンボーディング用の小さなPublic Domain引用セットです。

現行MAGINALIA Format v0.1のBook / Annotation形状に合わせています。

| Annotation | Work | Book ISBN |
|---|---|---|
| `ann:01JABCDEFGHJKMNPQRSTVWXYZ0` | 宮沢賢治「春と修羅」 | `9784480020024` |
| `ann:01JABCDEFGHJKMNPQRSTVWXYZ1` | 宮沢賢治「銀河鉄道の夜」 | `9784101092058` |
| `ann:01JABCDEFGHJKMNPQRSTVWXYZ2` | 三木清「如何に読書すべきか」 | `9784101019031` |

ページ番号は意図的に省略し、青空文庫図書カード/節を `location.path` に保持します。

新規Private Shelfならrepository identity templateと`library.json`を利用できます。

既存Private Shelfへ追加するときは:

- repository identityを置換しない
- `library.json`を置換しない
- 欠けているseed entityだけを現行Shelf contract経由で追加
- 既存Book metadataを優先
- 同一ID・別内容Annotationを上書きしない
