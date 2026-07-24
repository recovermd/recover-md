# ADR 0006 — Restore is atomic, append-only and refuses surprises

Status: accepted (v0.1)

## Context

Restore is the only operation that writes to the user's workspace. Everything else is
read-only. It is therefore the one place where a bug can destroy work rather than merely
fail to protect it.

## Decision

A restore performs a preflight, then an atomic write, then records itself.

**Preflight** — refuse rather than risk:

1. The version and its blob exist.
2. The stored bytes re-hash to the recorded SHA-256.
3. The destination canonicalises to a path inside the vault (symlinks resolved).
4. The current on-disk content is read and hashed.
5. If that hash differs from what the renderer saw when the dialog opened, return a
   **conflict** instead of writing (AC-12). A second, explicit confirmation is required.
6. If the current content is not already in history, it is captured first — so the restore
   itself is reversible.
7. Free disk space is checked.

**Write** — temporary file in the same directory → `fsync` → rename over the destination →
permissions preserved → temporary file cleaned up on both success and failure.

**Record** — a new `restore` version is appended. Nothing is deleted, nothing is rewritten,
no timeline pointer moves backwards. Undoing a restore is just another restore.

## Deleted-file recovery

The same machinery, with path-occupancy rules: never overwrite by default. The user is
offered `note (recovered).md` or an explicit replacement, and an explicit replacement first
captures the occupant's content and tombstones it, so the file being displaced keeps its own
history. (An integration test caught the original version of this: replacing left two active
rows at one path and violated the uniqueness constraint.)

## Consequences

- A crash mid-restore leaves either the old file or the new one, never a truncated note.
- "Restore" can never lose newer work: the newer content is captured before it is replaced.
- A no-op restore is detected and explained rather than performed.

## Implementation

`src/main/restore/restoreService.ts`, `src/main/restore/atomicWrite.ts`.
Tests: `tests/integration/restore.test.ts`.
