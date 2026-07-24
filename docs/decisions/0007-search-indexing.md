# ADR 0007 — Search is a rebuildable FTS5 index over versions

Status: accepted (v0.1)

## Context

The most distinctive thing Recover.MD can do is find text that no longer exists anywhere on
disk. That requires indexing history, not just current files.

## Decision

- An **FTS5** virtual table (`version_search`) indexes filename, path and content per
  version, with `unicode61 remove_diacritics 2`.
- The index is **derived data**. It can be dropped and rebuilt from `versions` + `blobs`
  without losing history, and a rebuild is exposed in settings.
- Search is **lexical**, not semantic, in the MVP.
- User input is never interpolated into FTS syntax: every token is quoted (see
  `queryParser.ts`), so `NEAR(`, `-`, `*` and stray quotes are searched for literally. A
  trailing `*` typed by the user is honoured as a prefix search.
- Tombstones are not indexed: they reference the previous version's blob and would show the
  same content twice.
- Results are grouped by logical file, with the current version first and repeated identical
  content within a file collapsed to its earliest occurrence.

## Consequences

- Deleting the index is a safe recovery action for a corrupted or stale index, and the
  health panel offers exactly that.
- Because indexing happens inside the same transaction as the version write, a version and
  its index entry cannot diverge under a crash.
- Non-UTF-8 versions are indexed by filename and path only; their content is not searchable,
  which the UI states explicitly rather than silently returning nothing.
- Semantic search, if it ever arrives, is an additive index — the schema does not prevent it.

## Implementation

`src/main/search/`, `src/main/storage/repositories/searchRepository.ts`.
Tests: `tests/unit/search.test.ts`, `tests/integration/searchAndHistory.test.ts`.
