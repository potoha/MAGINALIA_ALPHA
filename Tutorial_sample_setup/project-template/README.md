# MAGINALIA はじめてのプロジェクト

MAGINALIAの基本操作を試すための練習Projectです。

まず `sample-a_マキナの置き手紙.md` を開いてください。

ここにある文章は、壊しても、書き換えても大丈夫です。
チュートリアル後、このProjectを削除しても構いません。

`project.json.template` のProject IDと `project.magi.template` のProject UUIDは、同じ新規Project identityから生成します。Parent UUIDには選択中のPrimary Workdeskの `workdesk.magi` IDを使います。

MaterializeするときはRepository Coreの `templateFiles()` から `project.magi` と `project.json` を生成し、生成された `project.json` のIDをこのmetadata templateに適用してください。Format Project ULIDを別途生成したり、marker templateをそのまま実ファイルとしてコピーしたりしないでください。

`.magi`だけがProject folder identityです。`.maginalia/repository.json`を追加のidentityとして生成しません。
