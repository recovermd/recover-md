/** Restore and recovery against a real vault (Milestone 7 exit criteria). */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthMonitor } from '../../src/main/health/healthMonitor';
import { createNullLogger } from '../../src/main/logging/logger';
import { RestoreService } from '../../src/main/restore/restoreService';
import { hashBytes } from '../../src/main/storage/blobStore';
import { createTestEnv, type TestEnv } from '../helpers/testEnv';

let env: TestEnv;

afterEach(async () => {
  await env?.cleanup();
});

function createRestoreService(current: TestEnv): RestoreService {
  return new RestoreService({
    store: current.store,
    logger: createNullLogger(),
    health: new HealthMonitor(),
    context: () => ({
      root: current.root,
      vaultId: current.vaultId,
      capture: current.capture,
      suppressWatcher: () => undefined
    })
  });
}

describe('restore', () => {
  it('writes the stored bytes back exactly and appends a restore event (AC-11)', async () => {
    env = await createTestEnv();
    const restore = createRestoreService(env);

    const original = Buffer.from('# Original\r\n\r\nKeep every byte\n', 'utf8');
    const target = await env.writeFile('note.md', original);
    const first = await env.capture.captureFromDisk(target, 'initial_scan');
    if (first.status !== 'captured') throw new Error('expected capture');

    await env.writeFile('note.md', 'destroyed by an agent\n');
    const second = await env.capture.captureFromDisk(target, 'watcher');
    if (second.status !== 'captured') throw new Error('expected capture');

    const currentBytes = await env.readFile('note.md');
    const outcome = await restore.restore({
      versionId: first.version.id,
      expectedCurrentHash: hashBytes(currentBytes)
    });

    expect(outcome.status).toBe('restored');
    expect(Buffer.compare(await env.readFile('note.md'), original)).toBe(0);

    const versions = env.store.versions.listForFile(first.fileId);
    expect(versions[0]?.eventType).toBe('restore');
    expect(versions[0]?.origin).toBe('restore');
    // The newer version is still present: history is append-only.
    expect(versions.some((version) => version.id === second.version.id)).toBe(true);
    expect(versions).toHaveLength(3);
  });

  it('records unsaved current content before overwriting it, so a restore is reversible', async () => {
    env = await createTestEnv();
    const restore = createRestoreService(env);

    const target = await env.writeFile('note.md', 'version one\n');
    const first = await env.capture.captureFromDisk(target, 'initial_scan');
    if (first.status !== 'captured') throw new Error('expected capture');

    // Change on disk that Recover.MD has not captured yet.
    await env.writeFile('note.md', 'unsaved edit\n');
    const currentBytes = await env.readFile('note.md');

    await restore.restore({
      versionId: first.version.id,
      expectedCurrentHash: hashBytes(currentBytes)
    });

    const versions = env.store.versions.listForFile(first.fileId);
    const preserved = versions.find((version) => version.label === 'State before restore');
    expect(preserved).toBeDefined();

    const bytes = await env.store.blobs.get(preserved!.blobHash!);
    expect(bytes?.toString('utf8')).toBe('unsaved edit\n');
  });

  it('refuses to overwrite a file that changed after the dialog opened (AC-12)', async () => {
    env = await createTestEnv();
    const restore = createRestoreService(env);

    const target = await env.writeFile('note.md', 'one\n');
    const first = await env.capture.captureFromDisk(target, 'initial_scan');
    if (first.status !== 'captured') throw new Error('expected capture');

    const staleHash = hashBytes(await env.readFile('note.md'));
    await env.writeFile('note.md', 'someone else changed this\n');

    const conflicted = await restore.restore({
      versionId: first.version.id,
      expectedCurrentHash: staleHash
    });

    expect(conflicted.status).toBe('conflict');
    expect((await env.readFile('note.md')).toString()).toBe('someone else changed this\n');

    if (conflicted.status !== 'conflict') return;
    const forced = await restore.restore({
      versionId: first.version.id,
      expectedCurrentHash: conflicted.currentHash,
      force: true
    });
    expect(forced.status).toBe('restored');
    expect((await env.readFile('note.md')).toString()).toBe('one\n');
  });

  it('explains that nothing is needed when the file already matches', async () => {
    env = await createTestEnv();
    const restore = createRestoreService(env);

    const target = await env.writeFile('note.md', 'same\n');
    const first = await env.capture.captureFromDisk(target, 'initial_scan');
    if (first.status !== 'captured') throw new Error('expected capture');

    const outcome = await restore.restore({
      versionId: first.version.id,
      expectedCurrentHash: hashBytes(await env.readFile('note.md'))
    });

    expect(outcome).toMatchObject({ status: 'noop', reason: 'identical' });
    expect(env.store.versions.countForFile(first.fileId)).toBe(1);
  });

  it('leaves no temporary files behind', async () => {
    env = await createTestEnv();
    const restore = createRestoreService(env);

    const target = await env.writeFile('note.md', 'one\n');
    const first = await env.capture.captureFromDisk(target, 'initial_scan');
    if (first.status !== 'captured') throw new Error('expected capture');
    await env.writeFile('note.md', 'two\n');

    await restore.restore({
      versionId: first.version.id,
      expectedCurrentHash: hashBytes(await env.readFile('note.md'))
    });

    const entries = await fs.readdir(env.root);
    expect(entries.filter((entry) => entry.includes('recovermd-'))).toHaveLength(0);
  });
});

describe('deleted-file recovery', () => {
  it('recovers a deleted file to its last known path (AC-8)', async () => {
    env = await createTestEnv();
    const restore = createRestoreService(env);

    const target = await env.writeFile('notes/deep/gone.md', 'valuable\n');
    const created = await env.capture.captureFromDisk(target, 'initial_scan');
    if (created.status !== 'captured') throw new Error('expected capture');

    await fs.rm(target);
    const tombstone = env.capture.recordDeletion('notes/deep/gone.md', 'watcher');
    expect(tombstone).not.toBeNull();

    const outcome = await restore.recoverDeleted({
      versionId: created.version.id,
      onConflict: 'fail',
      createParentDirectories: true
    });

    expect(outcome).toMatchObject({ status: 'recovered', path: 'notes/deep/gone.md' });
    expect((await env.readFile('notes/deep/gone.md')).toString()).toBe('valuable\n');
    expect(env.store.files.byId(created.fileId)?.status).toBe('active');

    const latest = env.store.versions.latest(created.fileId);
    expect(latest?.eventType).toBe('recover');
  });

  it('re-creates a missing parent directory when asked', async () => {
    env = await createTestEnv();
    const restore = createRestoreService(env);

    const target = await env.writeFile('folder/a.md', 'content\n');
    const created = await env.capture.captureFromDisk(target, 'initial_scan');
    if (created.status !== 'captured') throw new Error('expected capture');

    await fs.rm(path.join(env.root, 'folder'), { recursive: true });
    env.capture.recordDeletion('folder/a.md', 'watcher');

    const refused = await restore.recoverDeleted({
      versionId: created.version.id,
      onConflict: 'fail',
      createParentDirectories: false
    });
    expect(refused.status).toBe('missing_parent');

    const accepted = await restore.recoverDeleted({
      versionId: created.version.id,
      onConflict: 'fail',
      createParentDirectories: true
    });
    expect(accepted.status).toBe('recovered');
  });

  it('never overwrites an occupied path by default (FR-8)', async () => {
    env = await createTestEnv();
    const restore = createRestoreService(env);

    const target = await env.writeFile('note.md', 'the old content\n');
    const created = await env.capture.captureFromDisk(target, 'initial_scan');
    if (created.status !== 'captured') throw new Error('expected capture');

    await fs.rm(target);
    env.capture.recordDeletion('note.md', 'watcher');
    await env.writeFile('note.md', 'something new lives here now\n');

    const blocked = await restore.recoverDeleted({
      versionId: created.version.id,
      onConflict: 'fail',
      createParentDirectories: true
    });

    expect(blocked).toMatchObject({ status: 'path_occupied', suggestedPath: 'note (recovered).md' });
    expect((await env.readFile('note.md')).toString()).toBe('something new lives here now\n');

    const renamed = await restore.recoverDeleted({
      versionId: created.version.id,
      onConflict: 'rename',
      createParentDirectories: true
    });
    expect(renamed).toMatchObject({ status: 'recovered', path: 'note (recovered).md' });
    expect((await env.readFile('note (recovered).md')).toString()).toBe('the old content\n');
    expect((await env.readFile('note.md')).toString()).toBe('something new lives here now\n');
  });

  it('records the occupant before an explicit replacement', async () => {
    env = await createTestEnv();
    const restore = createRestoreService(env);

    const target = await env.writeFile('note.md', 'original\n');
    const created = await env.capture.captureFromDisk(target, 'initial_scan');
    if (created.status !== 'captured') throw new Error('expected capture');

    await fs.rm(target);
    env.capture.recordDeletion('note.md', 'watcher');

    await env.writeFile('note.md', 'occupant\n');
    const occupant = await env.capture.captureFromDisk(target, 'watcher');
    if (occupant.status !== 'captured') throw new Error('expected capture');

    const replaced = await restore.recoverDeleted({
      versionId: created.version.id,
      onConflict: 'replace',
      createParentDirectories: true
    });

    expect(replaced.status).toBe('recovered');
    expect((await env.readFile('note.md')).toString()).toBe('original\n');

    // The occupant's own content is still recoverable.
    const occupantVersions = env.store.versions.listForFile(occupant.fileId);
    const occupantContent = await env.store.blobs.get(occupantVersions.at(-1)!.blobHash!);
    expect(occupantContent?.toString('utf8')).toBe('occupant\n');
  });

  it('refuses to write outside the vault', async () => {
    env = await createTestEnv();
    const restore = createRestoreService(env);

    const target = await env.writeFile('note.md', 'content\n');
    const created = await env.capture.captureFromDisk(target, 'initial_scan');
    if (created.status !== 'captured') throw new Error('expected capture');

    // Simulate a corrupted path record pointing outside the vault.
    env.store.files.setPath(created.fileId, '../escaped.md', '../escaped.md');

    const outcome = await restore.restore({
      versionId: created.version.id,
      expectedCurrentHash: null,
      force: true
    });
    expect(outcome.status).toBe('failed');
  });
});
