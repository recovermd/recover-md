/**
 * Composition root for persistence.
 *
 * `Store.open` is the only place that decides how the database is opened, migrated and —
 * if the integrity check fails — degraded into read-only safe mode (§19.1). Services take
 * a `Store` rather than a raw connection so they never manage that lifecycle themselves.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Database } from './database';
import { BackupManager } from './backupManager';
import { BlobStore } from './blobStore';
import { runMigrations, targetSchemaVersion } from './migrations';
import { FileRepository } from './repositories/fileRepository';
import { SearchRepository } from './repositories/searchRepository';
import { SettingsRepository } from './repositories/settingsRepository';
import { SkippedFileRepository } from './repositories/skippedFileRepository';
import { VaultRepository } from './repositories/vaultRepository';
import { VersionRepository } from './repositories/versionRepository';

export const DATABASE_FILENAME = 'recover.sqlite';

export interface StoreOpenOptions {
  /** Application-data directory. Always outside the watched vault (§20). */
  dataDir: string;
  /** Skip automatic backup/restore behaviour. Used by tests. */
  autoRecover?: boolean;
}

export interface StoreOpenReport {
  safeMode: boolean;
  restoredFromBackup: string | null;
  appliedMigrations: number[];
  schemaVersion: number;
}

export class Store {
  readonly vaults: VaultRepository;
  readonly files: FileRepository;
  readonly versions: VersionRepository;
  readonly search: SearchRepository;
  readonly settings: SettingsRepository;
  readonly skipped: SkippedFileRepository;
  readonly blobs: BlobStore;

  private constructor(
    readonly db: Database,
    readonly backups: BackupManager,
    readonly report: StoreOpenReport
  ) {
    this.vaults = new VaultRepository(db);
    this.files = new FileRepository(db);
    this.versions = new VersionRepository(db);
    this.search = new SearchRepository(db);
    this.settings = new SettingsRepository(db);
    this.skipped = new SkippedFileRepository(db);
    this.blobs = new BlobStore(db);
  }

  get safeMode(): boolean {
    return this.report.safeMode;
  }

  static async open(options: StoreOpenOptions): Promise<Store> {
    const { dataDir } = options;
    await fs.mkdir(dataDir, { recursive: true });
    const databasePath = path.join(dataDir, DATABASE_FILENAME);
    const backups = new BackupManager(path.join(dataDir, 'backups'));
    const autoRecover = options.autoRecover ?? true;

    const report: StoreOpenReport = {
      safeMode: false,
      restoredFromBackup: null,
      appliedMigrations: [],
      schemaVersion: 0
    };

    let db = await openChecked(databasePath);

    if (db === null && autoRecover) {
      // Integrity check failed. Try the newest valid backup before giving up (§19.1).
      const candidate = await backups.newestValid();
      if (candidate) {
        await backups.restoreOver(databasePath, candidate.filePath);
        report.restoredFromBackup = candidate.filePath;
        db = await openChecked(databasePath);
      }
    }

    if (db === null) {
      // Nothing valid to fall back to: expose the data read-only and stop writing (§19.1).
      const readOnly = new Database(databasePath, { readOnly: true, minimal: true });
      report.safeMode = true;
      return new Store(readOnly, backups, report);
    }

    const existingVersion =
      db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
      )?.n ?? 0;
    if (existingVersion > 0) {
      const current = db.get<{ v: number }>(
        'SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations'
      );
      if ((current?.v ?? 0) < targetSchemaVersion()) {
        // Back up before changing the schema (§19.1).
        await backups.create(db, 'pre-migration').catch(() => undefined);
      }
    }

    const result = runMigrations(db);
    report.appliedMigrations = result.applied;
    report.schemaVersion = result.currentVersion;

    return new Store(db, backups, report);
  }

  /** Convenience for tests and for the periodic daily backup. */
  async backup(reason: string): Promise<string | null> {
    if (this.safeMode) return null;
    return this.backups.create(this.db, reason);
  }

  async databaseBytes(): Promise<number> {
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      const stat = await fs.stat(`${this.db.filePath}${suffix}`).catch(() => null);
      if (stat) total += stat.size;
    }
    return total;
  }

  close(): void {
    this.db.close();
  }
}

/** Opens the database and returns null when it fails its integrity check. */
async function openChecked(databasePath: string): Promise<Database | null> {
  let db: Database;
  try {
    db = new Database(databasePath);
  } catch {
    return null;
  }
  try {
    const problems = db.integrityCheck();
    if (problems.length > 0) {
      db.close();
      return null;
    }
    return db;
  } catch {
    db.close();
    return null;
  }
}
