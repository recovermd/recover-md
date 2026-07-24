# ADR 0008 — Sandboxed renderer, validated IPC, no network

Status: accepted (v0.1)

## Context

Recover.MD reads a user's entire Markdown workspace and stores its history — including text
the user deleted — in a local database. It also renders Markdown that may have arrived from
an AI agent or any other source. The threat model is therefore: content in the vault should
not be able to reach the filesystem, the database or the network.

## Decision

**Renderer.** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no
webviews. Navigation away from the app is blocked; external links open in the system
browser.

**Bridge.** The preload exposes exactly two functions: `invoke(channel, payload)` and
`on(event, listener)`. There is no filesystem, database or `ipcRenderer` object in the
renderer.

**IPC.** One handler routes every request. A channel must appear in the router's map *and*
have a zod schema, or the request is rejected and logged. Handlers return a result envelope
rather than rejecting, so a main-process error cannot become an unhandled rejection in the
renderer.

**Markdown rendering.** Parsed with `marked`, sanitized with DOMPurify against an explicit
tag/attribute allowlist. Scripts, iframes, objects, forms, event handlers and inline styles
are removed. Remote images and embeds are **not fetched** — they are replaced with a visible
placeholder so the user knows something was blocked. Non-`http(s)`/`mailto` link targets are
stripped.

**Network.** `session.webRequest.onBeforeRequest` cancels every request that is not
`file:`, `devtools:`, `blob:` or `data:` (plus the dev server in development). A strict CSP
is set both as a response header and as a meta tag. There is no telemetry, no analytics, no
crash reporting, no remote fonts, no CDN assets and no update check.

**Filesystem.** The database lives in the application-data directory, never inside the
vault, and that directory is excluded from watching and scanning. Restore paths are
canonicalised through symlinks and rejected if they resolve outside the vault. Indexing is
read-only; Recover.MD writes no metadata files into the user's workspace.

## Known limitation

The database is **not encrypted** at rest in v0.1. Historical note content, including text
the user later deleted, is readable by anything that can read the user's files. The settings
panel states this plainly rather than leaving it implicit. Application-level encryption is on
the roadmap.

## Implementation

`src/main/app/main.ts` (`hardenSession`), `src/preload/index.ts`, `src/main/ipc/router.ts`,
`src/shared/validation/schemas.ts`, `src/renderer/lib/markdown.ts`.
