# Offline manual packaging input

This folder contains the finished Japanese user manual PDF supplied by the Product Owner. Keep `マニュアル.pdf` unchanged; this README is packaging guidance and is not user documentation.

The Windows package copies `マニュアル.pdf` to `resources/manual/`; the application opens `resources/manual/マニュアル.pdf` through the existing 「取扱説明書を開く」 action.

Verify that this PDF is present in the packaged application before publishing a release candidate. This README must never be presented as a substitute for the manual.
