/**
 * Access to the SQLite implementation bundled with the Node runtime inside Electron.
 *
 * `node:sqlite` is a *prefix-only* builtin: it appears in `module.builtinModules` as
 * `node:sqlite` but not as `sqlite`. Bundlers that strip the prefix before checking that
 * list (Vite and Rollup among them) therefore try to resolve a package called `sqlite` and
 * fail. Loading it through `createRequire` keeps the specifier out of the module graph, so
 * the same source works under Vitest, the electron-vite build and the packaged app.
 *
 * Using the runtime's own SQLite also means Recover.MD ships no native module to compile,
 * which removes a whole class of installation failures on Windows.
 */
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncClass, StatementSync } from 'node:sqlite';

type SqliteModule = {
  DatabaseSync: typeof DatabaseSyncClass;
  backup: (
    source: DatabaseSyncClass,
    destination: string,
    options?: Record<string, unknown>
  ) => Promise<number>;
};

const requireFromHere = createRequire(import.meta.url);
const sqlite = requireFromHere('node:sqlite') as SqliteModule;

export const DatabaseSync = sqlite.DatabaseSync;
export const backup = sqlite.backup;
export type { StatementSync };
export type DatabaseSyncInstance = InstanceType<typeof DatabaseSyncClass>;
