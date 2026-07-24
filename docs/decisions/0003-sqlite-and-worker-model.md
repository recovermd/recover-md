# ADR 0003 — `node:sqlite` on one serialized connection, CPU work off the main loop

Status: accepted (v0.1)

## Context

The PRD requires SQLite with WAL, foreign keys, transactions, migrations, a busy timeout,
FTS5 full-text search and a safe backup mechanism (§14, §19.1). It also requires that
expensive work stays off the renderer and preferably off the Electron main event loop (§15).

The default choice, `better-sqlite3`, is a native module. On this project's target
platforms that means either a prebuilt binary matching the exact Electron ABI or a local
C++ toolchain — the latter is a common and painful installation failure on Windows.

## Decision

1. Use **`node:sqlite`**, the SQLite implementation bundled with the Node runtime inside
   Electron. Verified present in Electron 43 (Node 24.18, SQLite 3.51) with FTS5, WAL and
   the online backup API.
2. Access it through **one serialized connection** owned by `Database`
   (`src/main/storage/database.ts`), which centralises pragmas, prepared-statement caching,
   nested transactions via savepoints, integrity checks and backups.
3. Import it through `createRequire` in `src/main/storage/sqliteBinding.ts`.
4. Run **diff computation in a worker thread**, with an automatic in-process fallback.
   Hashing and compression use the asynchronous `zlib`/`crypto` APIs, which already execute
   on the libuv thread pool.

## Why the `createRequire` indirection

`node:sqlite` is a *prefix-only* builtin: `module.builtinModules` contains `node:sqlite` but
not `sqlite`. Bundlers that strip the prefix before consulting that list — Vite and Rollup
among them — try to resolve a package named `sqlite` and fail. Loading it via `createRequire`
keeps the specifier out of the module graph, so one source file works under Vitest, the
electron-vite build and the packaged app.

## Consequences

- **No native module to compile**, and nothing to rebuild when Electron is upgraded. Tests
  run under plain Node with the same code path the app uses.
- SQLite writes are synchronous. This is a deliberate simplification: writes are small and
  serialising them removes a class of concurrency bugs. Capture work that *is* expensive
  (I/O, hashing, compression) happens before the transaction opens.
- The app is coupled to the runtime's SQLite version. It is currently marked experimental by
  Node, which is an accepted risk for a local-only store; the `Database` wrapper is the
  single place to change if it ever needs replacing.
- The diff worker must be unpacked from the asar archive (`asarUnpack` in `package.json`)
  because worker threads load from a real path. `DiffWorkerClient` falls back to computing
  in-process if the worker cannot start, so a packaging mistake degrades performance rather
  than breaking the diff view.
