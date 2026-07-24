/**
 * Database backups and recovery from corruption (§19.1).
 *
 * Policy: a backup before every migration, at least one per day while running, the three
 * most recent valid backups retained. Backups use the SQLite online backup API — never a
 * file copy of a live database.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BACKUP_RETENTION } from '@shared/constants';
import { Database } from './database';

export interface BackupInfo {
  filePath: string;
  createdAt: number;
  byteSize: number;
}

const BACKUP_PREFIX = 'recover-backup-';
const BACKUP_SUFFIX = '.sqlite';

function timestampName(at: Date): string {
  const iso = at.toISOString().replace(/[:.]/g, '-');
  return `${BACKUP_PREFIX}${iso}${BACKUP_SUFFIX}`;
}

export class BackupManager {
  constructor(private readonly backupDir: string) {}

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.backupDir, { recursive: true });
  }

  async list(): Promise<BackupInfo[]> {
    await this.ensureDir();
    const entries = await fs.readdir(this.backupDir);
    const infos: BackupInfo[] = [];
    for (const entry of entries) {
      if (!entry.startsWith(BACKUP_PREFIX) || !entry.endsWith(BACKUP_SUFFIX)) continue;
      const full = path.join(this.backupDir, entry);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat?.isFile()) continue;
      infos.push({ filePath: full, createdAt: stat.mtimeMs, byteSize: stat.size });
    }
    return infos.sort((a, b) => b.createdAt - a.createdAt);
  }

  async totalBytes(): Promise<number> {
    const list = await this.list();
    return list.reduce((sum, info) => sum + info.byteSize, 0);
  }

  /** Creates a backup and prunes old ones. Returns the new backup's path. */
  async create(db: Database, reason: string): Promise<string> {
    await this.ensureDir();
    const target = path.join(this.backupDir, timestampName(new Date()));
    await db.backupTo(target);
    // Reason is recorded next to the backup so a support log can explain why it exists.
    await fs.writeFile(`${target}.json`, JSON.stringify({ reason, at: Date.now() }), 'utf8');
    await this.prune();
    return target;
  }

  /** Keeps the newest {@link BACKUP_RETENTION} valid backups, deleting the rest. */
  async prune(retain = BACKUP_RETENTION): Promise<void> {
    const list = await this.list();
    for (const stale of list.slice(retain)) {
      await fs.rm(stale.filePath, { force: true });
      await fs.rm(`${stale.filePath}.json`, { force: true });
    }
  }

  /** Opens a backup read-only and runs an integrity check. */
  async validate(filePath: string): Promise<boolean> {
    let db: Database | null = null;
    try {
      db = new Database(filePath, { readOnly: true, minimal: true });
      const problems = db.integrityCheck();
      if (problems.length > 0) return false;
      const row = db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'versions'"
      );
      return (row?.n ?? 0) === 1;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }

  async newestValid(): Promise<BackupInfo | null> {
    for (const candidate of await this.list()) {
      if (await this.validate(candidate.filePath)) return candidate;
    }
    return null;
  }

  /**
   * Replaces a corrupt database with a backup. The corrupt file is preserved for
   * diagnostics rather than deleted (§19.1). The caller must have closed the database.
   */
  async restoreOver(databasePath: string, backupPath: string): Promise<void> {
    const quarantineDir = path.join(this.backupDir, 'corrupt');
    await fs.mkdir(quarantineDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantined = path.join(quarantineDir, `${path.basename(databasePath)}.${stamp}`);

    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${databasePath}${suffix}`;
      if (
        await fs
          .access(source)
          .then(() => true)
          .catch(() => false)
      ) {
        await fs.rename(source, `${quarantined}${suffix}`).catch(async () => {
          await fs.copyFile(source, `${quarantined}${suffix}`);
          await fs.rm(source, { force: true });
        });
      }
    }
    await fs.copyFile(backupPath, databasePath);
  }
}
