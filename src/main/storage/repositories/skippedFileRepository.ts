/** Files Recover.MD could not capture, surfaced as a warning list (FR-2, FR-12). */
import type { SkippedFileReport } from '@shared/types/domain';
import type { Database } from '../database';

interface SkippedRow {
  path: string;
  reason: string;
  detail: string;
  byte_size: number | null;
  at: number;
}

export class SkippedFileRepository {
  constructor(private readonly db: Database) {}

  record(vaultId: string, report: SkippedFileReport): void {
    this.db.run(
      `INSERT INTO skipped_files (path, vault_id, reason, detail, byte_size, at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(vault_id, path) DO UPDATE SET
         reason = excluded.reason, detail = excluded.detail,
         byte_size = excluded.byte_size, at = excluded.at`,
      [report.path, vaultId, report.reason, report.detail, report.byteSize, report.at]
    );
  }

  clearPath(vaultId: string, path: string): void {
    this.db.run('DELETE FROM skipped_files WHERE vault_id = ? AND path = ?', [vaultId, path]);
  }

  list(vaultId: string, limit = 200): SkippedFileReport[] {
    return this.db
      .all<SkippedRow>(
        `SELECT path, reason, detail, byte_size, at FROM skipped_files
         WHERE vault_id = ? ORDER BY at DESC LIMIT ?`,
        [vaultId, limit]
      )
      .map((row) => ({
        path: row.path,
        reason: row.reason as SkippedFileReport['reason'],
        detail: row.detail,
        byteSize: row.byte_size,
        at: row.at
      }));
  }

  count(vaultId: string): number {
    return (
      this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM skipped_files WHERE vault_id = ?', [
        vaultId
      ])?.n ?? 0
    );
  }
}
