# Architecture overview

Recover.MD is an Electron application with three process roles and a strict separation
between them: the **main process** owns the filesystem, the database and all decisions; the
**renderer** is a sandboxed view; a **worker thread** takes CPU-bound diff work off the main
event loop.

## Layers

```
src/
  main/
    app/        Electron entry point, window and tray, session hardening
    ipc/        One validated request router (§16)
    vault/      Vault lifecycle, path rules, ignore rules, scanner, coordinator
    watcher/    chokidar wrapper: filtering, buffering, restart with backoff
    capture/    Event coalescing, rename correlation, version capture, reconciliation
    storage/    SQLite connection, migrations, repositories, blobs, backups
    search/     FTS5 query building and result grouping
    history/    Timeline, version content, diff and storage-usage queries
    restore/    Preflight, atomic write, deleted-file recovery
    health/     Health issues and disk-space checks
    logging/    Rotating local log, metadata only
  preload/      The entire renderer capability surface: invoke + on
  renderer/     React UI (three panes), Zustand state, sanitized Markdown
  shared/       Domain types, IPC contract, zod schemas, constants
  workers/      Diff worker thread
```

Domain logic does not import Electron or React. That is what allows the capture pipeline,
restore service and search to be tested under plain Node, exactly as they run in the app.

## Capture flow

```
filesystem event
   → watcher (filter to tracked .md, buffer during initial scan)
   → capture queue (debounce, max interval, delete grace, per-file ordering)
   → stable read (retry; a read failure is never a deletion)
   → hash + compress (off the main event loop)
   → deduplicate against the latest content version
   → ONE transaction: blob + version + file pointer + search index
   → typed IPC event → renderer timeline
```

## Restore flow

```
renderer request
   → zod validation
   → preflight (version exists, blob verified, path inside vault,
                current state read and compared, current state captured)
   → conflict? stop and ask again
   → atomic write (temp file → fsync → rename)
   → append a restore version
   → watcher deduplicates the write it just caused
```

## Tracking state machine

`starting → indexing → active`, with `paused`, `degraded`, `unavailable` and `stopped` as
observable states. The state is always visible in the top bar and the tray, because a user
must be able to tell at a glance whether they are protected.

## What reconciliation can and cannot do

Reconciliation runs at startup, after wake, after a watcher restart and periodically. It
compares the vault with the database and captures the difference.

It can recover the **latest** state of a file that changed while Recover.MD was not running.
It cannot reconstruct the intermediate edits — those were never observed. Versions found
this way carry the origin `startup_reconciliation` and the label *"Changed while Recover.MD
was closed"*, and the UI never implies more than that.

## Attribution

Recover.MD labels *what* happened — Created, Edited, Large edit, Renamed, Deleted, Restored,
Recovered — and *how it was discovered* — first scan, live tracking, found at startup. It
never claims which application or agent made a change, because filesystem events do not
carry that information. Source attribution waits for explicit integrations.

## Decisions

See [`docs/decisions/`](../decisions/) for the reasoning behind full-snapshot storage,
compression, the SQLite and worker model, file identity, event coalescing, restore
atomicity, search indexing and the Electron security model.
