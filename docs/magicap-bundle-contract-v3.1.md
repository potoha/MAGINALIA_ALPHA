# MAGINALIA Capture Bundle v3.1 contract

Status: contract-only definition; no current import support

Inner package authority: [`.magicap` v3 contract in MAGINALIA_IDE](../../MAGINALIA_IDE/docs/magicap-contract-v3.md), governed by [ADR 0013](../../MAGINALIA_IDE/docs/decisions/0013-handwritten-canonical-source-assets.md) and amended by [ADR 0018](../../MAGINALIA_IDE/docs/decisions/0018-bookwithoutisbn-canonical-image-provenance.md)

This contract defines a new outer ZIP that groups existing, independent `.magicap` v3 ZIPs. It does not revise the v1, v2, or v3 standalone package schemas, their bytes, or their importer behavior.

## Identity and filenames

The outer format identifier is `maginalia-capture-bundle` and its version is the string `"3.1"`. A conforming filename is `.magicap.bundle`; `.magicap.bundle.zip` is an optional ZIP-suffixed alias. Both are ZIP archives with media type `application/zip`. The new suffix is distinct from the existing standalone `.magicap` and `.magicap.zip` suffixes. Filename alone never establishes the format: consumers validate the root manifest and every declared child.

The root member is `manifest.json`. Child package members are direct children of `packages/`, each ending in `.magicap`. The archive contains exactly the root manifest and the declared child packages. It contains no directory entries, extra files, nested bundles, or unreferenced data.

The root manifest has this shape:

```json
{
  "format": "maginalia-capture-bundle",
  "version": "3.1",
  "bundleId": "capbundle:01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "createdAt": "2026-10-12T02:30:00Z",
  "packages": [
    {
      "packageId": "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAW",
      "path": "packages/日本語の本.magicap",
      "sizeBytes": 1234,
      "sha256": "<64 lowercase hex digits over the exact child ZIP bytes>",
      "bookId": "capture-book-id-preserved-exactly",
      "get": { "date": "202610120930" },
      "captureIds": ["capture-01"]
    }
  ]
}
```

The normative root schema is [`magicap-bundle-v3.1-manifest.schema.json`](../sidecars/contracts/magicap-bundle-v3.1-manifest.schema.json). Archive-level, cross-record, and nested-package rules below supplement JSON Schema.

## Grouping and inner package identity

Each child is a complete, independent `.magicap` v3 ZIP and remains valid on its own. The inner v3 `manifest.json` remains the only source of truth for `source`, source files, package `createdAt`, and other bibliographic provenance. The outer manifest deliberately does not copy or reinterpret those fields.

Producers must wrap the exact existing child ZIP bytes. They must not unpack, rebuild, recompress, or rewrite an inner archive while bundling it. Outer ZIP compression is allowed only when reading that member reproduces the identical child byte sequence. SHA-256 identifies content integrity; it does not establish authorship or authorize redistribution.

One child represents captures sharing the exact decoded `capture.bookId` Unicode string and exact inner `manifest.get.date` string. Equality is by Unicode code point; equivalent JSON escapes decode to the same value. Consumers must not trim, normalize, derive, or replace the opaque `bookId` with an ISBN, Shelf ID, or another identifier. `get.date` must be a real calendar time in `YYYYMMDDHHMM`; this is stricter than the current standalone v3 schema's range-pattern check and applies only to bundle eligibility. A package must contain at least one capture so this grouping is evidenced by its contents. Standalone v3 keeps its existing empty-capture rules.

Different acquisition dates for the same opaque `bookId` require separate inner packages. Such packages may retain distinct sources or metadata snapshots; consumers do not infer that they describe one canonical Book or merge them. Duplicate exact `(bookId, get.date)` groups, duplicate package IDs, duplicate package paths (including aliases), or a capture ID repeated anywhere in the bundle invalidate the complete bundle. Page-image IDs remain local to each independent child package.

`captureIds` is the set of capture IDs in that child. The inner package ID, capture count, exact capture-ID set, and exact book/date values must match the outer record. The child ZIP byte count and SHA-256 must match `sizeBytes` and `sha256` before its contents are considered.

## Validation and resource-safety profile

Consumers validate the whole outer archive and every child before making durable changes. The reference validator under `sidecars/contracts/test_tools/` is test-only; it calls the current v3 validator against temporary staging and never persists Reviewer state.

The initial resource limits are:

| Limit | Maximum |
|---|---:|
| Compressed outer ZIP bytes | 512 MiB |
| Shared expanded bytes: outer entries plus every child entry | 2 GiB |
| Shared entry count: outer plus all child entries | 5,000 |
| Any single entry, including a child ZIP | 256 MiB |
| Compression ratio at each ZIP layer | 200:1 |
| Each JSON manifest or capture record | 1 MiB |

Budgets are shared across the bundle; they do not reset for each child. Consumers check central-directory metadata before extraction and still bound actual streamed reads, verify actual sizes and ZIP CRCs, and hash exact child bytes. Archive depth is exactly outer bundle → standalone v3 package; nested bundles are rejected.

ZIP entries must be regular files, unencrypted, and named with safe relative paths. Reject symbolic links and special files; duplicate names and aliases under case folding or Unicode normalization; absolute, drive, UNC, backslash, NUL, control-character, empty, `.` or `..` components; Windows-illegal `<`, `>`, `"`, `|`, `?`, or `*` characters; ADS colons; components ending in dot or space; and Windows reserved device components. Unicode filenames are allowed when they satisfy these checks and are encoded as UTF-8 in ZIP metadata. Directory entries are not allowed. The outer archive's member set must exactly equal `manifest.json` plus the child paths declared by the schema-valid manifest. These bundle eligibility checks are stricter than some legacy standalone v3 importer checks; they do not change or retroactively reject standalone packages.

Outer and inner manifests and capture JSON use strict UTF-8 without a byte-order mark, reject duplicate object keys and non-finite numbers, and reject unpaired surrogate strings. The inner manifest must validate as the existing v3 contract. Child validation also verifies each v3 canonical source file's exact SHA-256 and existing capture image rules through the current v3 validator.

Any failure rejects the complete bundle before import begins. Errors identify the bundle or child path and the violated rule without treating a partial set of children as a successful import.

## Future import failure policy

Import remains a read-only transfer of pending Capture data. Import does not delete or mutate the input bundle, create canonical human-verified quotes, approve captures, or infer human-verified text. A future importer must validate all children before durable writes and coordinate Reviewer database state with staged assets. A normal failure rolls back only state and staging created by that uncommitted attempt while preserving pre-existing data and the input.

A future importer must prove a coordinated transaction or journal across database and asset writes. If a crash or external failure leaves any package committed or uncertain, it must not claim bundle success or automatically delete existing or possibly user-reviewed data. It reports `RECOVERY_REQUIRED` with truthful per-package state, then requires explicit recovery/retry checks that are idempotent. This document defines the policy; it does not claim that current import code implements it or that crash recovery has been tested.

For duplicate-import safety, a future importer must preflight the bundle ID and every package ID against durable import identity and digest records before writing. It must never overwrite a package with the same ID; an ID already associated with different bytes is a conflict. The default policy is to reject the entire bundle if any child was already imported, rather than silently skipping that child. Recovery or explicit retry uses a committed per-package identity-and-digest ledger, preserves user edits, and reports each package's actual state. The schema validator has no durable state and does not prove these idempotency properties.

## Compatibility and current support

- Standalone `.magicap` v1 and v2 retain their existing legacy-readable behavior.
- Standalone `.magicap` v3 retains its existing manifest, schema, ZIP members, and importer semantics.
- An outer bundle has its own format ID, string version, bundle ID, extension, and manifest schema. It is not a standalone `.magicap` package and must not be routed to the legacy generic-ZIP path.
- The current Reviewer importer and Desktop picker do not import this outer format. This contract and its tests provide no runtime-import or Electron-smoke evidence.
- The currently checked-in `.magicap` v3 schema has not yet adopted the D069 file-backed `bookwithoutisbn` alternative. The sample package uses a URL-backed `bookwithoutisbn` with canonical image evidence so it validates against that unchanged schema. Applying the D069 alternative to v3 schema/importer validation remains a separate consumer-alignment task; this bundle contract does not revise v3.
- `17_CAPTURE_REVIEW_UX_SPEC.md` continues to describe the current picker, which accepts `.magicap` / `.magicap.zip`. Bundle suffix routing and UI support require a separate implementation slice.
