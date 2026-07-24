# Known limitations — v0.1

Recorded honestly so nobody has to discover these the hard way.

## By design (PRD non-goals)

- One vault at a time. The schema is multi-vault ready; the UI is not.
- No cloud, no sync, no accounts, no collaboration, no mobile.
- No Git interoperability, branches or merges.
- No workspace-wide rollback; restore is per file.
- No automatic partial restore. Historical text can be selected and copied, but restoring
  part of a file is manual.
- Only `.md` files are versioned. Attachments and other file types are not.
- History is never deleted automatically. There are no retention rules and no export.
- The database is **not encrypted**. Historical content, including text you deleted, is
  readable by anything that can read your user account's files.

## Real constraints

- **History starts when you select the folder.** Nothing from before that exists.
- **Edits made while Recover.MD is not running cannot be reconstructed.** On the next start
  only the file's latest state is captured, labelled *"Changed while Recover.MD was closed"*.
- **Ambiguous renames become a delete plus a create.** Both documents keep their history,
  but the link between them is lost. This is deliberate: merging unrelated histories is
  worse than losing a link.
- **Files larger than 10 MB are skipped** and listed in the health panel.
- **Files that are not valid UTF-8** are still stored byte-exactly and can be restored, but
  they have no preview, no diff and no content search.
- **Symlinked directories are not followed**, so notes reachable only through a symlink are
  not tracked.
- **Network shares and cloud placeholder files** (OneDrive/Dropbox "online-only") are not
  supported. Unreadable placeholders are skipped with a warning.
- Remote images and embeds are never loaded in the preview; a placeholder is shown instead.

## Not yet verified in this build

- **Performance against the reference dataset** (50,000 files / 250,000 versions, §18) has
  not been measured. The implementation follows the design the targets assume — bounded
  concurrency, content deduplication, virtualized rendering, indexed queries — but the
  numbers in §18 are unverified.
- **End-to-end UI automation** (Playwright/`electron` driver, §25) is not implemented. UI
  behaviour was verified manually and through a renderer smoke harness; the main-process
  pipeline is covered by integration tests that use the real filesystem and database.
- **The macOS application has not been run.** CI does execute the full automated suite and
  the production build on macOS, Windows and Linux, so the capture pipeline, rename
  correlation, restore and search are verified on all three. What remains unverified on
  macOS is everything CI cannot exercise headlessly: the menu-bar item, the folder picker,
  launch-at-login, window behaviour and the packaged `.dmg`.
- **Signed installers** are not produced; `electron-builder` configuration exists but no
  code-signing identity is configured.
