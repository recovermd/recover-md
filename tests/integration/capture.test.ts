/** Capture pipeline against a real temporary vault (Milestone 4 exit criteria). */
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { hashBytes } from '../../src/main/storage/blobStore';
import { createTestEnv, type TestEnv } from '../helpers/testEnv';

let env: TestEnv;

afterEach(async () => {
  await env?.cleanup();
});

describe('capture', () => {
  it('creates one baseline version per file on the first scan (AC-1)', async () => {
    env = await createTestEnv();
    const target = await env.writeFile('notes/plan.md', '# Plan\n\nFirst line\n');

    const result = await env.capture.captureFromDisk(target, 'initial_scan');
    expect(result.status).toBe('captured');
    if (result.status !== 'captured') return;

    expect(result.version.eventType).toBe('baseline');
    expect(result.version.sequence).toBe(1);
    expect(result.version.origin).toBe('initial_scan');
    expect(result.version.lineCount).toBe(3);
    expect(result.version.path).toBe('notes/plan.md');
  });

  it('records a new version when content changes (AC-2)', async () => {
    env = await createTestEnv();
    const target = await env.writeFile('a.md', 'one\n');
    await env.capture.captureFromDisk(target, 'initial_scan');

    await env.writeFile('a.md', 'one\ntwo\n');
    const result = await env.capture.captureFromDisk(target, 'watcher');

    expect(result.status).toBe('captured');
    if (result.status !== 'captured') return;
    expect(result.version.eventType).toBe('modify');
    expect(result.version.sequence).toBe(2);
    expect(result.version.addedLines).toBe(1);
    expect(result.version.removedLines).toBe(0);
    expect(result.version.previousVersionId).not.toBeNull();
  });

  it('does not create a duplicate version for identical bytes (AC-5)', async () => {
    env = await createTestEnv();
    const target = await env.writeFile('a.md', 'stable\n');
    const first = await env.capture.captureFromDisk(target, 'initial_scan');
    expect(first.status).toBe('captured');

    const second = await env.capture.captureFromDisk(target, 'watcher');
    const third = await env.capture.captureFromDisk(target, 'watcher');

    expect(second.status).toBe('unchanged');
    expect(third.status).toBe('unchanged');
    if (first.status !== 'captured') return;
    expect(env.store.versions.countForFile(first.fileId)).toBe(1);
  });

  it('reuses one blob when two files hold identical content', async () => {
    env = await createTestEnv();
    const a = await env.writeFile('a.md', 'same content\n');
    const b = await env.writeFile('b.md', 'same content\n');

    await env.capture.captureFromDisk(a, 'initial_scan');
    await env.capture.captureFromDisk(b, 'initial_scan');

    expect(env.store.blobs.stats().count).toBe(1);
    expect(env.store.versions.total()).toBe(2);
  });

  it('stores bytes exactly, including BOM, CRLF and no trailing newline', async () => {
    env = await createTestEnv();
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('# Title\r\n\r\nno trailing newline', 'utf8')
    ]);
    const target = await env.writeFile('exact.md', original);

    const result = await env.capture.captureFromDisk(target, 'initial_scan');
    if (result.status !== 'captured') throw new Error('expected capture');

    const stored = await env.store.blobs.get(result.version.blobHash!);
    expect(Buffer.compare(stored!, original)).toBe(0);
  });

  it('preserves content that is not valid UTF-8, without preview or line stats', async () => {
    env = await createTestEnv();
    const invalid = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x00, 0x41]);
    const target = await env.writeFile('binary.md', invalid);

    const result = await env.capture.captureFromDisk(target, 'initial_scan');
    if (result.status !== 'captured') throw new Error('expected capture');

    expect(result.version.lineCount).toBeNull();
    expect(result.version.metadata.textUnsupported).toBe(true);

    const stored = await env.store.blobs.get(result.version.blobHash!);
    expect(Buffer.compare(stored!, invalid)).toBe(0);
  });

  it('skips files above the size limit and reports them', async () => {
    env = await createTestEnv({ maxFileBytes: 64 });
    const target = await env.writeFile('big.md', 'x'.repeat(500));

    const result = await env.capture.captureFromDisk(target, 'initial_scan');
    expect(result.status).toBe('skipped');
    expect(env.events.skipped[0]?.reason).toBe('too_large');
    expect(env.store.skipped.list(env.vaultId)).toHaveLength(1);
  });

  it('ignores files outside the vault and non-Markdown files', async () => {
    env = await createTestEnv();
    await env.writeFile('note.txt', 'not markdown');
    const outside = await env.capture.captureFromDisk('/definitely/outside/a.md', 'watcher');
    const notMarkdown = await env.capture.captureFromDisk(env.absolute('note.txt'), 'watcher');

    expect(outside.status).toBe('ignored');
    expect(notMarkdown.status).toBe('ignored');
  });

  it('reports a missing file rather than inventing a deletion (§19.4)', async () => {
    env = await createTestEnv();
    const result = await env.capture.captureFromDisk(env.absolute('never-existed.md'), 'watcher');
    expect(result.status).toBe('missing');
  });
});

describe('deletion', () => {
  it('writes a tombstone that keeps the content recoverable (AC-8)', async () => {
    env = await createTestEnv();
    const target = await env.writeFile('gone.md', 'important\n');
    const created = await env.capture.captureFromDisk(target, 'initial_scan');
    if (created.status !== 'captured') throw new Error('expected capture');

    await fs.rm(target);
    const tombstone = env.capture.recordDeletion('gone.md', 'watcher');

    expect(tombstone?.eventType).toBe('delete');
    expect(tombstone?.blobHash).toBe(created.version.blobHash);
    expect(env.store.files.byId(created.fileId)?.status).toBe('deleted');

    const recoverable = await env.store.blobs.get(tombstone!.blobHash!);
    expect(recoverable?.toString('utf8')).toBe('important\n');
  });

  it('does not write a second tombstone for an already deleted file', async () => {
    env = await createTestEnv();
    const target = await env.writeFile('gone.md', 'x\n');
    await env.capture.captureFromDisk(target, 'initial_scan');
    await fs.rm(target);

    expect(env.capture.recordDeletion('gone.md', 'watcher')).not.toBeNull();
    expect(env.capture.recordDeletion('gone.md', 'watcher')).toBeNull();
  });

  it('continues the same timeline when identical content reappears at the path', async () => {
    env = await createTestEnv();
    const target = await env.writeFile('flap.md', 'content\n');
    const created = await env.capture.captureFromDisk(target, 'initial_scan');
    if (created.status !== 'captured') throw new Error('expected capture');

    await fs.rm(target);
    env.capture.recordDeletion('flap.md', 'watcher');

    await env.writeFile('flap.md', 'content\n');
    const back = await env.capture.captureFromDisk(target, 'watcher');
    if (back.status !== 'captured') throw new Error('expected capture');

    expect(back.fileId).toBe(created.fileId);
    expect(back.version.eventType).toBe('create');
  });

  it('starts a new logical file when different content appears at a deleted path', async () => {
    env = await createTestEnv();
    const target = await env.writeFile('reused.md', 'original\n');
    const created = await env.capture.captureFromDisk(target, 'initial_scan');
    if (created.status !== 'captured') throw new Error('expected capture');

    await fs.rm(target);
    env.capture.recordDeletion('reused.md', 'watcher');

    await env.writeFile('reused.md', 'a totally different document\n');
    const fresh = await env.capture.captureFromDisk(target, 'watcher');
    if (fresh.status !== 'captured') throw new Error('expected capture');

    // Histories of unrelated documents must never be merged (§8).
    expect(fresh.fileId).not.toBe(created.fileId);
    expect(fresh.version.eventType).toBe('create');
  });
});

describe('rename', () => {
  it('keeps one timeline when a rename is claimed confidently (AC-7)', async () => {
    env = await createTestEnv();
    const original = await env.writeFile('old-name.md', 'moving content\n');
    const created = await env.capture.captureFromDisk(original, 'initial_scan');
    if (created.status !== 'captured') throw new Error('expected capture');

    await fs.rename(original, env.absolute('new-name.md'));

    const renamed = await env.capture.captureFromDisk(env.absolute('new-name.md'), 'watcher', {
      claimRename: (candidate) =>
        candidate.contentHash === created.version.blobHash
          ? { fileId: created.fileId, fromDisplayPath: 'old-name.md' }
          : null
    });

    if (renamed.status !== 'captured') throw new Error('expected capture');
    expect(renamed.fileId).toBe(created.fileId);
    expect(renamed.version.eventType).toBe('rename');
    expect(renamed.version.metadata.renamedFrom).toBe('old-name.md');
    expect(env.store.files.byId(created.fileId)?.currentPath).toBe('new-name.md');
    expect(env.store.versions.countForFile(created.fileId)).toBe(2);
  });

  it('creates a separate file when no rename is claimed', async () => {
    env = await createTestEnv();
    const original = await env.writeFile('old.md', 'content\n');
    const created = await env.capture.captureFromDisk(original, 'initial_scan');
    if (created.status !== 'captured') throw new Error('expected capture');

    await fs.rename(original, env.absolute('new.md'));
    const result = await env.capture.captureFromDisk(env.absolute('new.md'), 'watcher', {
      claimRename: () => null
    });

    if (result.status !== 'captured') throw new Error('expected capture');
    expect(result.fileId).not.toBe(created.fileId);
  });
});

describe('capture events', () => {
  it('emits versionCaptured and fileStateChanged for observers', async () => {
    env = await createTestEnv();
    const target = await env.writeFile('a.md', 'one\n');
    await env.capture.captureFromDisk(target, 'watcher');
    await fs.rm(target);
    env.capture.recordDeletion('a.md', 'watcher');

    expect(env.events.versions.length).toBe(2);
    expect(env.events.states.map((event) => event.status)).toEqual(['active', 'deleted']);
  });

  it('hashes stored content consistently with the version record', async () => {
    env = await createTestEnv();
    const target = await env.writeFile('a.md', 'hash me\n');
    const result = await env.capture.captureFromDisk(target, 'initial_scan');
    if (result.status !== 'captured') throw new Error('expected capture');

    const bytes = await env.readFile('a.md');
    expect(result.version.blobHash).toBe(hashBytes(bytes));
    expect(result.version.byteSize).toBe(bytes.byteLength);
  });
});
