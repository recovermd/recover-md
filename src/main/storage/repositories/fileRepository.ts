/**
 * Logical-file rows (§14.2).
 *
 * A file's identity is independent of its path: a confidently detected rename keeps the
 * same row (and therefore the same timeline), while an ambiguous one produces a new row.
 */
import { randomUUID } from 'node:crypto';
import type { FileStatus, FileSummary, TrackedFile } from '@shared/types/domain';
import type { Database } from '../database';

interface FileRow {
  id: string;
  vault_id: string;
  current_path: string;
  normalized_path: string;
  status: string;
  current_version_id: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
}

function toRecord(row: FileRow): TrackedFile {
  return {
    id: row.id,
    vaultId: row.vault_id,
    currentPath: row.current_path,
    normalizedPath: row.normalized_path,
    status: row.status as FileStatus,
    currentVersionId: row.current_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at
  };
}

const SELECT = `SELECT id, vault_id, current_path, normalized_path, status,
                       current_version_id, created_at, updated_at, last_seen_at FROM files`;

export interface CreateFileInput {
  vaultId: string;
  currentPath: string;
  normalizedPath: string;
  status?: FileStatus;
}

export class FileRepository {
  constructor(private readonly db: Database) {}

  create(input: CreateFileInput): TrackedFile {
    const now = Date.now();
    const id = randomUUID();
    this.db.run(
      `INSERT INTO files (id, vault_id, current_path, normalized_path, status,
                          current_version_id, created_at, updated_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        id,
        input.vaultId,
        input.currentPath,
        input.normalizedPath,
        input.status ?? 'active',
        now,
        now,
        now
      ]
    );
    return {
      id,
      vaultId: input.vaultId,
      currentPath: input.currentPath,
      normalizedPath: input.normalizedPath,
      status: input.status ?? 'active',
      currentVersionId: null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now
    };
  }

  byId(id: string): TrackedFile | null {
    const row = this.db.get<FileRow>(`${SELECT} WHERE id = ?`, [id]);
    return row ? toRecord(row) : null;
  }

  activeByNormalizedPath(vaultId: string, normalizedPath: string): TrackedFile | null {
    const row = this.db.get<FileRow>(
      `${SELECT} WHERE vault_id = ? AND normalized_path = ? AND status = 'active'`,
      [vaultId, normalizedPath]
    );
    return row ? toRecord(row) : null;
  }

  /** Most recently updated deleted row at a path — the candidate for "the file came back". */
  latestDeletedByNormalizedPath(vaultId: string, normalizedPath: string): TrackedFile | null {
    const row = this.db.get<FileRow>(
      `${SELECT} WHERE vault_id = ? AND normalized_path = ? AND status = 'deleted'
       ORDER BY updated_at DESC LIMIT 1`,
      [vaultId, normalizedPath]
    );
    return row ? toRecord(row) : null;
  }

  listActive(vaultId: string): TrackedFile[] {
    return this.db
      .all<FileRow>(`${SELECT} WHERE vault_id = ? AND status = 'active'`, [vaultId])
      .map(toRecord);
  }

  setCurrentVersion(fileId: string, versionId: string): void {
    this.db.run('UPDATE files SET current_version_id = ?, updated_at = ? WHERE id = ?', [
      versionId,
      Date.now(),
      fileId
    ]);
  }

  setStatus(fileId: string, status: FileStatus): void {
    this.db.run('UPDATE files SET status = ?, updated_at = ? WHERE id = ?', [
      status,
      Date.now(),
      fileId
    ]);
  }

  setPath(fileId: string, currentPath: string, normalizedPath: string): void {
    this.db.run(
      'UPDATE files SET current_path = ?, normalized_path = ?, updated_at = ? WHERE id = ?',
      [currentPath, normalizedPath, Date.now(), fileId]
    );
  }

  touch(fileId: string, at = Date.now()): void {
    this.db.run('UPDATE files SET last_seen_at = ? WHERE id = ?', [at, fileId]);
  }

  /** Powers the file tree and the deleted-files view (§21). */
  list(
    vaultId: string,
    filter: 'all' | 'active' | 'deleted',
    query: string | undefined,
    limit: number,
    offset: number
  ): FileSummary[] {
    const clauses = ['f.vault_id = ?'];
    const params: (string | number)[] = [vaultId];
    if (filter !== 'all') {
      clauses.push('f.status = ?');
      params.push(filter);
    }
    if (query && query.trim().length > 0) {
      clauses.push('f.normalized_path LIKE ?');
      params.push(`%${query.trim().toLowerCase()}%`);
    }
    params.push(limit, offset);

    const rows = this.db.all<{
      id: string;
      current_path: string;
      normalized_path: string;
      status: string;
      version_count: number;
      last_captured_at: number | null;
      byte_size: number | null;
    }>(
      `SELECT f.id, f.current_path, f.normalized_path, f.status,
              (SELECT COUNT(*) FROM versions v WHERE v.file_id = f.id) AS version_count,
              (SELECT MAX(v.captured_at) FROM versions v WHERE v.file_id = f.id) AS last_captured_at,
              (SELECT v.byte_size FROM versions v WHERE v.id = f.current_version_id) AS byte_size
       FROM files f
       WHERE ${clauses.join(' AND ')}
       ORDER BY f.normalized_path ASC
       LIMIT ? OFFSET ?`,
      params
    );

    return rows.map((row) => ({
      id: row.id,
      currentPath: row.current_path,
      normalizedPath: row.normalized_path,
      status: row.status as FileStatus,
      versionCount: row.version_count,
      lastCapturedAt: row.last_captured_at,
      byteSize: row.byte_size ?? 0
    }));
  }

  count(vaultId: string): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM files WHERE vault_id = ?', [
      vaultId
    ])?.n ?? 0;
  }
}
