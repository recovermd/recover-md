/** Storage layer against a real SQLite file (Milestone 2 exit criteria). */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/main/storage/database';
import { BlobStore, hashBytes } from '../../src/main/storage/blobStore';
import { MIGRATIONS, runMigrations } from '../../src/main/storage/migrations';
import { Store } from '../../src/main/storage/store';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recovermd-store-'));
  cleanups.push(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  return dir;
}

describe('migrations', () => {
  it('runs from a clean database and is idempotent', async () => {
    const dir = await tempDir();
    const db = new Database(path.join(dir, 'test.sqlite'));
    cleanups.push(async () => db.close());

    const first = runMigrations(db);
    expect(first.applied).toEqual(MIGRATIONS.map((m) => m.version));
    expect(first.currentVersion).toBe(MIGRATIONS.length);

    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.currentVersion).toBe(MIGRATIONS.length);
  });

  it('refuses to run when an applied migration has changed', async () => {
    const dir = await tempDir();
    const db = new Database(path.join(dir, 'test.sqlite'));
    cleanups.push(async () => db.close());

    runMigrations(db);
    const tampered = [{ version: 1, name: 'initial_schema', sql: 'SELECT 1;' }];
    expect(() => runMigrations(db, tampered)).toThrow(/has changed/);
  });

  it('enables WAL and foreign keys', async () => {
    const dir = await tempDir();
    const db = new Database(path.join(dir, 'test.sqlite'));
    cleanups.push(async () => db.close());

    expect(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    expect(db.integrityCheck()).toEqual([]);
  });
});

describe('transactions', () => {
  it('rolls back everything when the body throws (§19.5)', async () => {
    const dir = await tempDir();
    const db = new Database(path.join(dir, 'test.sqlite'));
    cleanups.push(async () => db.close());
    runMigrations(db);

    expect(() =>
      db.transaction(() => {
        db.run(
          "INSERT INTO blobs (hash, codec, compressed_data, raw_size, compressed_size, created_at) VALUES ('h', 'identity', ?, 1, 1, 1)",
          [Buffer.from([1])]
        );
        throw new Error('boom');
      })
    ).toThrow('boom');

    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blobs')?.n).toBe(0);
  });

  it('supports nested transactions via savepoints', async () => {
    const dir = await tempDir();
    const db = new Database(path.join(dir, 'test.sqlite'));
    cleanups.push(async () => db.close());
    runMigrations(db);

    db.transaction(() => {
      db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', ['a', '1', 1]);
      try {
        db.transaction(() => {
          db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', ['b', '2', 1]);
          throw new Error('inner');
        });
      } catch {
        // The inner savepoint rolls back; the outer transaction survives.
      }
    });

    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM settings')?.n).toBe(1);
  });
});

describe('blob storage', () => {
  it('round-trips bytes exactly, including a BOM and CRLF', async () => {
    const dir = await tempDir();
    const db = new Database(path.join(dir, 'test.sqlite'));
    cleanups.push(async () => db.close());
    runMigrations(db);
    const blobs = new BlobStore(db);

    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# Title\r\n\r\nBody with émoji 🎉 and trailing space \r\n', 'utf8')
    ]);

    const stored = await blobs.put(original);
    const readBack = await blobs.get(stored.hash);
    expect(readBack).not.toBeNull();
    expect(Buffer.compare(readBack!, original)).toBe(0);
    expect(hashBytes(readBack!)).toBe(stored.hash);
  });

  it('stores identical content once (content addressing, §13)', async () => {
    const dir = await tempDir();
    const db = new Database(path.join(dir, 'test.sqlite'));
    cleanups.push(async () => db.close());
    runMigrations(db);
    const blobs = new BlobStore(db);

    const bytes = Buffer.from('repeated content\n');
    const first = await blobs.put(bytes);
    const second = await blobs.put(bytes);

    expect(second.hash).toBe(first.hash);
    expect(second.deduplicated).toBe(true);
    expect(blobs.stats().count).toBe(1);
  });

  it('handles empty files', async () => {
    const dir = await tempDir();
    const db = new Database(path.join(dir, 'test.sqlite'));
    cleanups.push(async () => db.close());
    runMigrations(db);
    const blobs = new BlobStore(db);

    const stored = await blobs.put(Buffer.alloc(0));
    const readBack = await blobs.get(stored.hash);
    expect(readBack?.byteLength).toBe(0);
    expect(await blobs.verify(stored.hash)).toBe(true);
  });

  it('falls back to identity coding when compression does not help', async () => {
    const dir = await tempDir();
    const db = new Database(path.join(dir, 'test.sqlite'));
    cleanups.push(async () => db.close());
    runMigrations(db);
    const blobs = new BlobStore(db);

    const random = Buffer.from(Array.from({ length: 24 }, (_, i) => (i * 37) % 256));
    const stored = await blobs.put(random);
    const readBack = await blobs.get(stored.hash);
    expect(Buffer.compare(readBack!, random)).toBe(0);
  });
});

describe('backups', () => {
  it('creates a valid backup and restores over a damaged database (§19.1)', async () => {
    const dir = await tempDir();
    const store = await Store.open({ dataDir: dir });

    const vault = store.vaults.upsert(dir, dir);
    const file = store.files.create({
      vaultId: vault.id,
      currentPath: 'a.md',
      normalizedPath: 'a.md'
    });
    await store.blobs.put(Buffer.from('hello\n'));
    store.versions.insert({
      fileId: file.id,
      eventType: 'baseline',
      path: 'a.md',
      sourceMtimeMs: 1,
      blobHash: null,
      byteSize: 6,
      lineCount: 1,
      addedLines: 1,
      removedLines: 0,
      origin: 'initial_scan'
    });

    const backupPath = await store.backups.create(store.db, 'test');
    expect(await store.backups.validate(backupPath)).toBe(true);
    store.close();

    // Corrupt the database file, then reopen: the store should recover from the backup.
    const databasePath = path.join(dir, 'recover.sqlite');
    await fs.writeFile(databasePath, Buffer.alloc(8192, 0x7a));

    const recovered = await Store.open({ dataDir: dir });
    expect(recovered.safeMode).toBe(false);
    expect(recovered.report.restoredFromBackup).toBe(backupPath);
    expect(recovered.versions.total()).toBe(1);
    recovered.close();
  });

  it('keeps only the three most recent backups', async () => {
    const dir = await tempDir();
    const store = await Store.open({ dataDir: dir });
    cleanups.push(async () => store.close());

    for (let i = 0; i < 5; i += 1) {
      await store.backups.create(store.db, `test-${i}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect((await store.backups.list()).length).toBe(3);
  });

  it('enters read-only safe mode when nothing valid can be restored', async () => {
    const dir = await tempDir();
    const store = await Store.open({ dataDir: dir });
    store.close();

    await fs.writeFile(path.join(dir, 'recover.sqlite'), Buffer.alloc(8192, 0x5a));
    const damaged = await Store.open({ dataDir: dir });
    cleanups.push(async () => damaged.close());

    expect(damaged.safeMode).toBe(true);
  });
});
