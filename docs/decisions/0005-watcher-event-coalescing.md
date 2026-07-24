# ADR 0005 — Filesystem events are coalesced into stable states

Status: accepted (v0.1)

## Context

Filesystem events are noisy. A single save in an editor can produce several events; an AI
agent rewriting a file produces bursts; an editor that saves atomically produces a *deletion*
followed by a creation. Mapping events to versions one-to-one would produce a timeline full
of duplicates, partial writes and phantom deletions.

## Decision

Events never map directly to versions. They enter a queue
(`src/main/capture/captureQueue.ts`) that applies four rules:

| Rule | Behaviour | Why |
| --- | --- | --- |
| Debounce | A write schedules a capture `snapshotDelay` (default 2 s) ahead; another write resets it | One version per stable state (AC-3) |
| Maximum interval | A file edited continuously is still captured every 60 s | Continuous editing must not postpone history forever (AC-4) |
| Delete grace | An unlink waits 2 s; a write in that window cancels it | An atomic save reads as a modification, not a delete (AC-6) |
| Per-file serialization | Work for one file never overlaps itself; different files run with bounded concurrency | Ordering within a file is what makes sequences meaningful (FR-3) |

Two further checks sit behind the queue:

- **Content deduplication.** Even after coalescing, identical bytes never create a second
  version — the hash is compared with the latest content version first (AC-5).
- **A read failure is never a deletion.** Reads retry with backoff, and a file that is
  merely locked or mid-write is reported as an error, not a tombstone (§19.4). Before a
  tombstone is finally written, the file's absence is re-checked.

## Consequences

- Ten writes in two seconds produce one version.
- The debounce is user-configurable between 1 s and 30 s; the maximum interval is fixed at
  60 s in the MVP.
- Because captures are deferred, the UI must distinguish "recorded" from "about to be
  recorded" — the queue exposes a pending count that surfaces as *Recording change…*
  rather than implying the change is already safe.
- On shutdown the queue is flushed so pending work is not lost.
