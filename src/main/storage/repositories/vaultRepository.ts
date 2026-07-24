/** Vault rows (§14.1). One vault exists in v0.1, but the schema is multi-vault ready. */
import { randomUUID } from 'node:crypto';
import type { TrackingState, VaultRecord } from '@shared/types/domain';
import type { Database } from '../database';

interface VaultRow {
  id: string;
  root_path: string;
  canonical_root_path: string;
  created_at: number;
  updated_at: number;
  last_scan_at: number | null;
  tracking_state: string;
  settings_json: string;
}

function toRecord(row: VaultRow): VaultRecord {
  return {
    id: row.id,
    rootPath: row.root_path,
    canonicalRootPath: row.canonical_root_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastScanAt: row.last_scan_at,
    trackingState: row.tracking_state as TrackingState
  };
}

const SELECT = `SELECT id, root_path, canonical_root_path, created_at, updated_at,
                       last_scan_at, tracking_state, settings_json FROM vaults`;

export class VaultRepository {
  constructor(private readonly db: Database) {}

  /** Returns the vault for a canonical root, creating it on first use. */
  upsert(rootPath: string, canonicalRootPath: string): VaultRecord {
    const existing = this.db.get<VaultRow>(`${SELECT} WHERE canonical_root_path = ?`, [
      canonicalRootPath
    ]);
    const now = Date.now();
    if (existing) {
      this.db.run('UPDATE vaults SET root_path = ?, updated_at = ? WHERE id = ?', [
        rootPath,
        now,
        existing.id
      ]);
      return toRecord({ ...existing, root_path: rootPath, updated_at: now });
    }
    const id = randomUUID();
    this.db.run(
      `INSERT INTO vaults (id, root_path, canonical_root_path, created_at, updated_at,
                           last_scan_at, tracking_state, settings_json)
       VALUES (?, ?, ?, ?, ?, NULL, 'starting', '{}')`,
      [id, rootPath, canonicalRootPath, now, now]
    );
    return {
      id,
      rootPath,
      canonicalRootPath,
      createdAt: now,
      updatedAt: now,
      lastScanAt: null,
      trackingState: 'starting'
    };
  }

  byId(id: string): VaultRecord | null {
    const row = this.db.get<VaultRow>(`${SELECT} WHERE id = ?`, [id]);
    return row ? toRecord(row) : null;
  }

  /** The most recently used vault, used to resume tracking at launch (FR-1). */
  mostRecent(): VaultRecord | null {
    const row = this.db.get<VaultRow>(`${SELECT} ORDER BY updated_at DESC LIMIT 1`);
    return row ? toRecord(row) : null;
  }

  setTrackingState(id: string, state: TrackingState): void {
    this.db.run('UPDATE vaults SET tracking_state = ?, updated_at = ? WHERE id = ?', [
      state,
      Date.now(),
      id
    ]);
  }

  markScanned(id: string, at = Date.now()): void {
    this.db.run('UPDATE vaults SET last_scan_at = ?, updated_at = ? WHERE id = ?', [at, at, id]);
  }
}
