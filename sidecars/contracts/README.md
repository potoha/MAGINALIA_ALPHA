# Data contracts

`manifest-v1.schema.json` is the PHONE-to-PC ZIP manifest. The ZIP contains only
that `manifest.json` member and the JPEG members referenced by `pages[].imagePath`.

`published-book-v1.schema.json` is the image-free allowlist committed to
`marginalia/v1/books/<isbn13>.json`. It intentionally has no page image, complete
OCR text, geometry, stroke, or raw engine-output field.

Readers reject unknown schema versions and unknown object properties. Times are
UTC Unix epoch milliseconds. Page arrays are ordered by `capturedAtMs`, then `id`.

Readers additionally enforce ISBN checksum, unique page/region/annotation/highlight
IDs and image paths, increasing point order, non-degenerate rectangles, page ordering,
and a 10 MiB maximum serialized publication. These cross-field and aggregate rules
cannot be expressed completely by JSON Schema. Empty context is valid only at a book
or captured-page boundary; the PC reviewer requires human confirmation. `coverUrl`
must be HTTPS. Publication intentionally excludes description and raw page/OCR data.

The `fixtures` directory includes valid examples plus deliberately invalid version
and image-leak examples for negative parser tests.
