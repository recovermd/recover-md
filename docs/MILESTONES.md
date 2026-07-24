# Milestone status — v0.1 build

Against the implementation plan in §26 of the PRD.

| # | Milestone | Status | Notes |
| --- | --- | --- | --- |
| 1 | Project foundation | Complete | Electron 43 + React + strict TS + Vite + Tailwind, typed IPC, sandboxed preload, ESLint/Prettier, Vitest, rotating local logging, GitHub Actions CI on Windows/macOS/Linux |
| 2 | Database and blob storage | Complete | `node:sqlite` (WAL, FK, busy timeout), checksummed migrations, repositories, SHA-256 content addressing, Brotli, nested transactions, backups + integrity checks + safe mode |
| 3 | Initial indexing | Complete | Folder selection, ignore rules, recursive scanner, baseline capture, progress events, watcher buffers events during the scan and replays them |
| 4 | Watcher and snapshot pipeline | Complete | Coalescing, debounce, 60 s maximum interval, atomic-save handling, rename correlation, tombstones, startup/wake/periodic reconciliation, bounded queue |
| 5 | Application shell and timeline | Complete | Three panes, file list, grouped timeline, version details, tracking and index status, empty/error states, live updates |
| 6 | Preview and diff | Complete | Sanitized preview (no scripts, no remote loads), raw source, line diff with counts, compare-to-previous/current, virtualized rendering |
| 7 | Restore and recovery | Complete | Preflight, conflict detection, pre-restore capture, atomic replacement, restore events, deleted-file recovery with occupied-path handling |
| 8 | Historical search | Complete | FTS5 across current and historical content, filenames and paths, grouping, snippets, highlighting, scope filters, index rebuild |
| 9 | Background runtime and resilience | Complete | Tray with status, launch at login, pause/resume, health diagnostics, watcher restart with backoff, disk-full pause, database safe mode, backup restore, storage usage |
| 10 | Packaging and release validation | Partial | `electron-builder` configured for NSIS and dmg/zip with icons and asar unpacking; installers have not been produced, signed, or clean-install tested, and macOS has not been exercised |

## Acceptance criteria

Covered by automated tests: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10,
AC-11, AC-12, AC-13, AC-14, AC-16, AC-19 (transaction rollback under failure).

Implemented and manually verified, not yet automated: AC-15 (tray keeps tracking with the
window closed), AC-17 (offline operation — enforced by blocking all outbound requests),
AC-18 (disk-full pause).

Not verified: AC-20 (performance against the reference dataset), AC-21 (installable builds
on both platforms).

See [LIMITATIONS.md](LIMITATIONS.md) for the full list of what this build does not do.
