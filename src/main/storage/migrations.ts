/**
 * Schema migrations (§14.7).
 *
 * Migrations are append-only: never edit an applied migration, add a new one. Each is
 * checksummed on apply so a tampered or diverged history is detected at startup.
 */
import { createHash } from 'node:crypto';
import type { Database } from './database';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATION_001 = `
CREATE TABLE vaults (
  id                  TEXT PRIMARY KEY,
  root_path           TEXT NOT NULL,
  canonical_root_path TEXT NOT NULL UNIQUE,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  last_scan_at        INTEGER,
  tracking_state      TEXT NOT NULL,
  settings_json       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE files (
  id                 TEXT PRIMARY KEY,
  vault_id           TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  current_path       TEXT NOT NULL,
  normalized_path    TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active','deleted','unavailable')),
  -- Deliberately not a foreign key: files and versions reference each other, and the
  -- capture transaction inserts the version after the file row exists.
  current_version_id TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  last_seen_at       INTEGER
);

CREATE INDEX idx_files_vault_path ON files(vault_id, normalized_path);
CREATE INDEX idx_files_status ON files(status);
CREATE UNIQUE INDEX idx_files_active_path
  ON files(vault_id, normalized_path) WHERE status = 'active';

CREATE TABLE blobs (
  hash            TEXT PRIMARY KEY,
  codec           TEXT NOT NULL,
  compressed_data BLOB NOT NULL,
  raw_size        INTEGER NOT NULL,
  compressed_size INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE versions (
  id                  TEXT PRIMARY KEY,
  file_id             TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  sequence            INTEGER NOT NULL,
  event_type          TEXT NOT NULL CHECK (event_type IN
                        ('baseline','create','modify','rename','delete','restore','recover')),
  path                TEXT NOT NULL,
  captured_at         INTEGER NOT NULL,
  source_mtime_ms     INTEGER,
  blob_hash           TEXT REFERENCES blobs(hash),
  byte_size           INTEGER NOT NULL DEFAULT 0,
  line_count          INTEGER,
  added_lines         INTEGER,
  removed_lines       INTEGER,
  previous_version_id TEXT REFERENCES versions(id),
  origin              TEXT NOT NULL CHECK (origin IN
                        ('initial_scan','watcher','startup_reconciliation',
                         'periodic_reconciliation','restore','recovery')),
  label               TEXT,
  metadata_json       TEXT NOT NULL DEFAULT '{}',
  UNIQUE (file_id, sequence)
);

CREATE INDEX idx_versions_file_sequence ON versions(file_id, sequence);
CREATE INDEX idx_versions_captured_at ON versions(captured_at);
CREATE INDEX idx_versions_blob ON versions(blob_hash);
CREATE INDEX idx_versions_previous ON versions(previous_version_id);

CREATE VIRTUAL TABLE version_search USING fts5(
  version_id UNINDEXED,
  file_id    UNINDEXED,
  filename,
  path,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE skipped_files (
  path       TEXT NOT NULL,
  vault_id   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  detail     TEXT NOT NULL,
  byte_size  INTEGER,
  at         INTEGER NOT NULL,
  PRIMARY KEY (vault_id, path)
);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial_schema', sql: MIGRATION_001 }
];

export function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      checksum   TEXT NOT NULL
    )
  `);
}

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
}

/** Applies every pending migration in one transaction each. Idempotent. */
export function runMigrations(
  db: Database,
  migrations: readonly Migration[] = MIGRATIONS
): MigrationResult {
  ensureMigrationTable(db);

  const existing = db.all<{ version: number; checksum: string; name: string }>(
    'SELECT version, checksum, name FROM schema_migrations ORDER BY version'
  );
  const byVersion = new Map(existing.map((row) => [row.version, row]));

  for (const applied of existing) {
    const known = migrations.find((m) => m.version === applied.version);
    if (!known) {
      throw new Error(
        `Database contains unknown migration ${applied.version} (${applied.name}). ` +
          'It was probably written by a newer version of Recover.MD.'
      );
    }
    if (checksum(known.sql) !== applied.checksum) {
      throw new Error(
        `Migration ${applied.version} (${applied.name}) has changed since it was applied.`
      );
    }
  }

  const appliedNow: number[] = [];
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (byVersion.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.run(
        'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
        [migration.version, migration.name, Date.now(), checksum(migration.sql)]
      );
    });
    appliedNow.push(migration.version);
  }

  const current = db.get<{ version: number }>(
    'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations'
  );
  return { applied: appliedNow, currentVersion: current?.version ?? 0 };
}

/** Highest migration version this build knows about. */
export function targetSchemaVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}
