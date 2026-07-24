/**
 * Version rows (§14.4) — the immutable history.
 *
 * Nothing in this repository updates or deletes a version: history is append-only, which
 * is what makes "restore never destroys newer history" (FR-7) structurally true rather
 * than a convention.
 */
import { randomUUID } from 'node:crypto';
import type {
  CaptureOrigin,
  VersionEventType,
  VersionRecord
} from '@shared/types/domain';
import type { Database } from '../database';

interface VersionRow {
  id: string;
  file_id: string;
  sequence: number;
  event_type: string;
  path: string;
  captured_at: number;
  source_mtime_ms: number | null;
  blob_hash: string | null;
  byte_size: number;
  line_count: number | null;
  added_lines: number | null;
  removed_lines: number | null;
  previous_version_id: string | null;
  origin: string;
  label: string | null;
  metadata_json: string;
}

function toRecord(row: VersionRow): VersionRecord {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.metadata_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    fileId: row.file_id,
    sequence: row.sequence,
    eventType: row.event_type as VersionEventType,
    path: row.path,
    capturedAt: row.captured_at,
    sourceMtimeMs: row.source_mtime_ms,
    blobHash: row.blob_hash,
    byteSize: row.byte_size,
    lineCount: row.line_count,
    addedLines: row.added_lines,
    removedLines: row.removed_lines,
    previousVersionId: row.previous_version_id,
    origin: row.origin as CaptureOrigin,
    label: row.label,
    metadata
  };
}

const SELECT = `SELECT id, file_id, sequence, event_type, path, captured_at, source_mtime_ms,
                       blob_hash, byte_size, line_count, added_lines, removed_lines,
                       previous_version_id, origin, label, metadata_json FROM versions`;

export interface InsertVersionInput {
  fileId: string;
  eventType: VersionEventType;
  path: string;
  capturedAt?: number;
  sourceMtimeMs: number | null;
  blobHash: string | null;
  byteSize: number;
  lineCount: number | null;
  addedLines: number | null;
  removedLines: number | null;
  origin: CaptureOrigin;
  label?: string | null;
  metadata?: Record<string, unknown>;
}

export class VersionRepository {
  constructor(private readonly db: Database) {}

  /**
   * Appends a version. The per-file sequence is allocated here, inside the caller's
   * transaction, so concurrent captures for the same file cannot collide (FR-4).
   */
  insert(input: InsertVersionInput): VersionRecord {
    const previous = this.latest(input.fileId);
    const sequence = (previous?.sequence ?? 0) + 1;
    const id = randomUUID();
    const capturedAt = input.capturedAt ?? Date.now();
    const metadataJson = JSON.stringify(input.metadata ?? {});

    this.db.run(
      `INSERT INTO versions (id, file_id, sequence, event_type, path, captured_at,
                             source_mtime_ms, blob_hash, byte_size, line_count,
                             added_lines, removed_lines, previous_version_id, origin,
                             label, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.fileId,
        sequence,
        input.eventType,
        input.path,
        capturedAt,
        input.sourceMtimeMs,
        input.blobHash,
        input.byteSize,
        input.lineCount,
        input.addedLines,
        input.removedLines,
        previous?.id ?? null,
        input.origin,
        input.label ?? null,
        metadataJson
      ]
    );

    return {
      id,
      fileId: input.fileId,
      sequence,
      eventType: input.eventType,
      path: input.path,
      capturedAt,
      sourceMtimeMs: input.sourceMtimeMs,
      blobHash: input.blobHash,
      byteSize: input.byteSize,
      lineCount: input.lineCount,
      addedLines: input.addedLines,
      removedLines: input.removedLines,
      previousVersionId: previous?.id ?? null,
      origin: input.origin,
      label: input.label ?? null,
      metadata: input.metadata ?? {}
    };
  }

  byId(id: string): VersionRecord | null {
    const row = this.db.get<VersionRow>(`${SELECT} WHERE id = ?`, [id]);
    return row ? toRecord(row) : null;
  }

  /** Highest-sequence version for a file, whatever its event type. */
  latest(fileId: string): VersionRecord | null {
    const row = this.db.get<VersionRow>(
      `${SELECT} WHERE file_id = ? ORDER BY sequence DESC LIMIT 1`,
      [fileId]
    );
    return row ? toRecord(row) : null;
  }

  /**
   * Latest version that represents live content — used for deduplication. A tombstone is
   * excluded so that re-creating a deleted file with identical bytes still records an event.
   */
  latestContent(fileId: string): VersionRecord | null {
    const row = this.db.get<VersionRow>(
      `${SELECT} WHERE file_id = ? AND blob_hash IS NOT NULL AND event_type <> 'delete'
       ORDER BY sequence DESC LIMIT 1`,
      [fileId]
    );
    return row ? toRecord(row) : null;
  }

  /** Nearest earlier version carrying content, used as the default diff baseline (FR-6). */
  previousContent(fileId: string, sequence: number): VersionRecord | null {
    const row = this.db.get<VersionRow>(
      `${SELECT} WHERE file_id = ? AND sequence < ? AND blob_hash IS NOT NULL
       ORDER BY sequence DESC LIMIT 1`,
      [fileId, sequence]
    );
    return row ? toRecord(row) : null;
  }

  listForFile(fileId: string, limit = 500, offset = 0): VersionRecord[] {
    return this.db
      .all<VersionRow>(`${SELECT} WHERE file_id = ? ORDER BY sequence DESC LIMIT ? OFFSET ?`, [
        fileId,
        limit,
        offset
      ])
      .map(toRecord);
  }

  countForFile(fileId: string): number {
    return (
      this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM versions WHERE file_id = ?', [fileId])
        ?.n ?? 0
    );
  }

  total(): number {
    return this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM versions')?.n ?? 0;
  }

  /** Streams every version for a search-index rebuild (FR-9). */
  *iterateAll(batchSize = 500): Generator<VersionRecord[]> {
    let offset = 0;
    for (;;) {
      const rows = this.db.all<VersionRow>(
        `${SELECT} ORDER BY captured_at ASC, id ASC LIMIT ? OFFSET ?`,
        [batchSize, offset]
      );
      if (rows.length === 0) return;
      yield rows.map(toRecord);
      offset += rows.length;
    }
  }
}
