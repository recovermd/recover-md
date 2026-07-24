/**
 * Full-text index rows (§14.5).
 *
 * This table is *derived data*: it can be dropped and rebuilt from `versions` + `blobs`
 * without losing history, which is why FR-9 allows a rebuild action in settings.
 */
import type { SearchScope, VersionEventType } from '@shared/types/domain';
import type { Database } from '../database';

export interface IndexEntry {
  versionId: string;
  fileId: string;
  filename: string;
  path: string;
  /** Null when the version's bytes are not valid UTF-8; filename/path stay searchable. */
  content: string | null;
}

export interface RawSearchMatch {
  version_id: string;
  file_id: string;
  path: string;
  captured_at: number;
  event_type: string;
  current_path: string;
  file_status: string;
  is_current: number;
  blob_hash: string | null;
  snippet: string;
  rank: number;
}

export interface SearchParams {
  matchExpression: string;
  scope: SearchScope;
  fromDate?: number | null;
  toDate?: number | null;
  limit: number;
  offset: number;
}

export interface RawSearchMatchTyped extends Omit<RawSearchMatch, 'event_type'> {
  event_type: VersionEventType;
}

export class SearchRepository {
  constructor(private readonly db: Database) {}

  index(entry: IndexEntry): void {
    this.db.run('DELETE FROM version_search WHERE version_id = ?', [entry.versionId]);
    this.db.run(
      `INSERT INTO version_search (version_id, file_id, filename, path, content)
       VALUES (?, ?, ?, ?, ?)`,
      [entry.versionId, entry.fileId, entry.filename, entry.path, entry.content ?? '']
    );
  }

  removeForVersion(versionId: string): void {
    this.db.run('DELETE FROM version_search WHERE version_id = ?', [versionId]);
  }

  clear(): void {
    this.db.run('DELETE FROM version_search');
  }

  count(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM version_search')?.n ?? 0;
  }

  /**
   * Runs a prepared FTS5 MATCH expression. Grouping and de-duplication happen in the
   * search service so they stay unit-testable without a database.
   */
  search(params: SearchParams): RawSearchMatchTyped[] {
    const clauses = ['version_search MATCH ?'];
    const values: (string | number)[] = [params.matchExpression];

    if (params.scope === 'current') {
      clauses.push('v.id = f.current_version_id');
    } else if (params.scope === 'historical') {
      clauses.push('(f.current_version_id IS NULL OR v.id <> f.current_version_id)');
    } else if (params.scope === 'deleted') {
      clauses.push("f.status = 'deleted'");
    }
    if (params.fromDate != null) {
      clauses.push('v.captured_at >= ?');
      values.push(params.fromDate);
    }
    if (params.toDate != null) {
      clauses.push('v.captured_at <= ?');
      values.push(params.toDate);
    }
    values.push(params.limit, params.offset);

    return this.db.all<RawSearchMatchTyped>(
      `SELECT version_search.version_id AS version_id,
              version_search.file_id     AS file_id,
              v.path                     AS path,
              v.captured_at              AS captured_at,
              v.event_type               AS event_type,
              v.blob_hash                AS blob_hash,
              f.current_path             AS current_path,
              f.status                   AS file_status,
              CASE WHEN v.id = f.current_version_id THEN 1 ELSE 0 END AS is_current,
              snippet(version_search, 4, '', '', '…', 12) AS snippet,
              bm25(version_search) AS rank
       FROM version_search
       JOIN versions v ON v.id = version_search.version_id
       JOIN files f ON f.id = v.file_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY rank ASC, v.captured_at DESC
       LIMIT ? OFFSET ?`,
      values
    );
  }
}
