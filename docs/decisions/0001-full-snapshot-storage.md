# ADR 0001 — Full compressed snapshots are the source of truth

Status: accepted (v0.1)

## Context

Recover.MD stores the history of a Markdown workspace. The obvious storage model for a
version history is a chain of diffs: keep one full copy and reconstruct any older state by
replaying deltas backwards. It is compact, and it is what most version-control systems do.

The product promise, however, is *recovery*. The value of the whole application collapses if
a restore cannot reproduce the original bytes.

## Decision

Every unique version is stored as a **complete, compressed copy** of the original file
bytes. Diffs are computed on demand from two stored versions and are never used to
reconstruct content.

## Consequences

Positive:

- **Corruption is isolated.** A damaged blob costs one version, not every version after it.
  A diff chain fails catastrophically: one bad delta invalidates everything downstream.
- **Restore is a single lookup**, so it is fast and easy to verify (hash the blob, compare
  with the recorded hash, write).
- **Historical search** reads a version directly instead of replaying a chain.
- **Exact bytes** survive: no normalisation of line endings, encoding or whitespace.
- Testing and migrations are simpler because a version has no dependencies on its siblings.

Negative:

- More bytes on disk than a delta chain.

The cost is mitigated by two properties of the domain: Markdown compresses extremely well
(Brotli typically reaches 3–5×), and content-addressed storage means an edit that is later
reverted, or the same content in two files, is stored once (see
[ADR 0002](0002-blob-compression.md)).

## Alternatives considered

- **Delta chains with periodic full snapshots.** Reduces the blast radius but keeps the
  complexity, and still makes restore depend on multiple records being intact.
- **Delta compression inside the blob store.** Not rejected — deliberately deferred. The
  blob store exposes `put(bytes) → hash` and `get(hash) → bytes`; a future version can
  introduce deltas behind that interface without changing version semantics.

## Implementation

`src/main/storage/blobStore.ts`, `src/main/storage/repositories/versionRepository.ts`.
