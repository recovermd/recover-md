# ADR 0004 — File identity is separate from path; renames are correlated conservatively

Status: accepted (v0.1)

## Context

A rename on disk is not one event. The operating system reports a disappearance and an
appearance, and Recover.MD has to decide whether they describe one document that moved or
two unrelated documents. Getting this wrong in the permissive direction is the worst failure
the product can have short of data loss: it **merges the histories of two different notes**.

## Decision

**Identity is a row in `files`, not a path.** A version records the path it had when it was
captured; the file row records where the document lives now.

A disappearance is held rather than committed. When a file appears with no tracked history
at its path, it may *claim* a held deletion, in this priority order:

1. **Filesystem identity** — matching inode and device, when the platform reports non-zero
   values (recorded in version metadata at capture time).
2. **Content match** — identical SHA-256 *and* identical byte size, inside the correlation
   window.
3. **No claim.** The deletion becomes a tombstone and the new file starts its own history.

Two guards make ambiguity fail safe:

- If more than one held deletion matches the same content, nothing is claimed. We cannot
  tell which document moved, so we refuse to guess.
- A size mismatch rejects the claim even if hashes match.

## Timing

The deletion is registered the moment the unlink event arrives, **not** when the delete
grace period expires. This was a bug found by an end-to-end test: with a 1 s debounce and a
2 s grace period, the moved file's capture ran a full second before the deletion existed to
be claimed, so every rename degraded to delete-plus-create. The correlation window is sized
as `debounce + delete grace + correlation window` so a claim is still possible with a long
user-configured debounce.

## Related rule: a file reappearing at a deleted path

If content appears at a path that was previously tombstoned, its history continues **only**
when the content matches what was last seen there. Otherwise a new logical file is created.
Same conservative principle: same path is weak evidence, matching content is strong.

## Consequences

- A confidently detected rename keeps one timeline and shows both paths (AC-7).
- An ambiguous one produces a delete and a create. Both documents keep their full history;
  nothing is lost, only the link between them.
- On Windows, where inode reporting is unreliable, content matching does the work.

## Implementation

`src/main/capture/renameCorrelator.ts`, `src/main/vault/vaultCoordinator.ts`,
`src/main/capture/captureService.ts`. Tests: `tests/unit/renameCorrelator.test.ts`,
`tests/integration/watcher.test.ts`, `tests/integration/capture.test.ts`.
