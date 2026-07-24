# ADR 0002 — Content addressing with Brotli compression

Status: accepted (v0.1)

## Context

Given [ADR 0001](0001-full-snapshot-storage.md), each version stores whole file contents.
Two forces push back on storage growth: repeated content and compressibility.

## Decision

- Hash the raw bytes with **SHA-256** and use the hash as the blob's identity.
- Compress with **Brotli** (quality 5) through the asynchronous `zlib` API.
- If compression does not shrink the input, store the raw bytes under the `identity` codec.
- A blob row is written once; many versions and many files may reference the same hash.

## Consequences

- An edit that is later reverted costs nothing: the reverted content already exists.
- Duplicated notes across a vault are stored once.
- Deduplication is what makes "no automatic history deletion" affordable in the MVP.
- The `codec` column means a future version can add codecs without a data migration.
- Compression runs on the libuv thread pool, so the main event loop is not blocked while a
  capture is prepared. Hashing and compression both happen *before* the write transaction
  opens, keeping transactions short.

Quality 5 was chosen over the maximum (11): on Markdown it gives most of the ratio at a
small fraction of the CPU cost, which matters because captures happen continuously in the
background.

## Verification

Round-trip byte-exactness — including a UTF-8 BOM, CRLF line endings and invalid UTF-8 —
is asserted in `tests/integration/storage.test.ts` and `tests/integration/capture.test.ts`.
`BlobStore.verify` re-hashes stored bytes and is called before every restore.
