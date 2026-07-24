/**
 * SQLite connection wrapper (§14).
 *
 * Wraps `node:sqlite` (bundled with the Node runtime inside Electron) so the rest of the
 * app never touches the driver directly. Responsibilities: pragmas, prepared-statement
 * caching, transactions, integrity checks and backups.
 *
 * Everything here is synchronous by design: SQLite writes are fast and serialising them
 * through one connection removes a whole class of concurrency bugs (§15).
 */
import {
  DatabaseSync,
  backup,
  type DatabaseSyncInstance,
  type StatementSync
} from './sqliteBinding';

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlParams = SqlValue[] | Record<string, SqlValue>;

export interface DatabaseOptions {
  readOnly?: boolean;
  /** Skip WAL/pragma setup; used when opening a candidate backup for validation. */
  minimal?: boolean;
}

export class DatabaseError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class Database {
  private readonly db: DatabaseSyncInstance;
  private readonly cache = new Map<string, StatementSync>();
  private savepointDepth = 0;
  private closed = false;

  constructor(
    readonly filePath: string,
    options: DatabaseOptions = {}
  ) {
    try {
      this.db = new DatabaseSync(filePath, {
        readOnly: options.readOnly ?? false,
        enableForeignKeyConstraints: true
      });
    } catch (error) {
      throw new DatabaseError(`Could not open database at ${filePath}`, error);
    }

    try {
      if (!options.minimal) {
        // WAL keeps readers unblocked while captures are written (§14).
        if (!options.readOnly) {
          this.db.exec('PRAGMA journal_mode = WAL');
          this.db.exec('PRAGMA synchronous = NORMAL');
        }
        this.db.exec('PRAGMA busy_timeout = 5000');
        this.db.exec('PRAGMA foreign_keys = ON');
      }
    } catch (error) {
      // A damaged file can open and then fail on the first statement. Release the handle
      // here or the file stays locked and cannot be quarantined (§19.1).
      this.closed = true;
      try {
        this.db.close();
      } catch {
        // Nothing more to do; the original failure is what matters.
      }
      throw new DatabaseError(`Could not initialise database at ${filePath}`, error);
    }
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  private statement(sql: string): StatementSync {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, params: SqlParams = []): { changes: number; lastInsertRowid: number } {
    const stmt = this.statement(sql);
    const result = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid)
    };
  }

  get<T>(sql: string, params: SqlParams = []): T | undefined {
    const stmt = this.statement(sql);
    const row = Array.isArray(params) ? stmt.get(...params) : stmt.get(params);
    return row as T | undefined;
  }

  all<T>(sql: string, params: SqlParams = []): T[] {
    const stmt = this.statement(sql);
    const rows = Array.isArray(params) ? stmt.all(...params) : stmt.all(params);
    return rows as T[];
  }

  /**
   * Runs `fn` inside a transaction. Nested calls use savepoints so a service can compose
   * repository operations without knowing whether it is already inside a transaction.
   * A throw always rolls back exactly the level it opened (§19.5).
   */
  transaction<T>(fn: () => T): T {
    const depth = this.savepointDepth;
    const name = `rmd_sp_${depth}`;
    if (depth === 0) {
      this.db.exec('BEGIN IMMEDIATE');
    } else {
      this.db.exec(`SAVEPOINT ${name}`);
    }
    this.savepointDepth = depth + 1;
    try {
      const result = fn();
      if (depth === 0) {
        this.db.exec('COMMIT');
      } else {
        this.db.exec(`RELEASE ${name}`);
      }
      return result;
    } catch (error) {
      try {
        if (depth === 0) {
          this.db.exec('ROLLBACK');
        } else {
          this.db.exec(`ROLLBACK TO ${name}`);
          this.db.exec(`RELEASE ${name}`);
        }
      } catch {
        // A rollback failure means the connection is unusable; surface the original error.
      }
      throw error;
    } finally {
      this.savepointDepth = depth;
    }
  }

  /** Returns `[]` when the database is healthy, otherwise the reported problems (§19.1). */
  integrityCheck(): string[] {
    const rows = this.all<{ integrity_check: string }>('PRAGMA integrity_check');
    return rows.map((row) => row.integrity_check).filter((value) => value !== 'ok');
  }

  /** Uses the SQLite online backup API rather than copying a live file (§19.1). */
  async backupTo(destinationPath: string): Promise<void> {
    await backup(this.db, destinationPath);
  }

  /** Truncates the WAL so a file-level copy of the database is coherent. */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    if (this.closed) return;
    this.cache.clear();
    this.closed = true;
    this.db.close();
  }
}
