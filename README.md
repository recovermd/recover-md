# Recover.MD

Local, automatic change history for Markdown workspaces.

Pick a folder once. Recover.MD then records every stable change to every `.md` file inside
it, so you can browse a file's timeline, see exactly what changed, search text that no
longer exists on disk, restore any earlier version and recover deleted files.

No Git. No commits. No account. No cloud. No network access at all.

> **Undo any change to your Markdown workspace — even when an AI made it.**

## What it does

- **Automatic capture.** Every stable change is recorded while Recover.MD is running; there
  is nothing to save, commit or sync.
- **Timeline per file**, grouped into Current / Today / Yesterday / This week / Older.
- **Preview, source and line diff**, with `+`/`−` markers as well as colour.
- **Full-text search across history**, including files you deleted.
- **Safe restore.** The current content is recorded first, the write is atomic, and newer
  history is never removed.
- **Deleted-file recovery**, which never overwrites something that has taken the path.
- **Runs in the tray/menu bar** so protection continues when the window is closed.

It deliberately does **not** claim to know which application or AI agent made a change:
filesystem events do not carry that information. Changes are labelled by *what* happened and
*how they were discovered*.

## Requirements

- Node.js 22+ (developed against Node 24) and npm.
- No C++ toolchain: the app uses the SQLite implementation bundled with the Node runtime
  inside Electron, so there is no native module to compile.

## Getting started

```bash
npm install
```

```bash
npm run dev
```

## Everyday commands

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run build:app
```

```bash
npm run package:win
```

`package:mac` builds the macOS installers. Both produce output in `release/`.

## Where things live

| What | Where |
| --- | --- |
| History database | `<userData>/recover.sqlite` — never inside your vault |
| Backups | `<userData>/backups` |
| Logs | `<userData>/logs` (operational metadata only, never note content) |

`<userData>` is `%APPDATA%\Recover.MD` on Windows and
`~/Library/Application Support/Recover.MD` on macOS. Both are reachable from the tray menu
and the settings panel.

## Storage in one line

Every unique version is stored as a **complete, Brotli-compressed copy** of the original
bytes, addressed by SHA-256, so identical content is stored once and a diff is only ever a
view — never the thing a restore depends on. See
[ADR 0001](docs/decisions/0001-full-snapshot-storage.md).

## Documentation

- [Architecture overview](docs/architecture/overview.md)
- [Architecture decision records](docs/decisions/)
- [Known limitations](docs/LIMITATIONS.md) — read this one

## Privacy

Everything stays on your machine. The app makes no network requests of its own; outbound
requests are blocked at the session level and a strict CSP is enforced. Historical note
content — including text you later deleted — is stored in a local SQLite database that is
**not encrypted** in this version, so its protection is your OS account and disk encryption.
