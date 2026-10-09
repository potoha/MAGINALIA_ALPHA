# Offline manual packaging input

The separately authored Japanese user manual is not included in this development build. This folder is only a packaging handoff location and is not user documentation.

When the Product Owner provides the reviewed manual, place the file named `マニュアル.pdf` in this folder. The Windows package copies it to `resources/manual/`; the application opens `resources/manual/マニュアル.pdf` through the existing 「取扱説明書を開く」 action.

Do not publish a release candidate while this folder lacks the finished manual PDF. This README is packaging guidance and must never be presented as a substitute for the manual.
