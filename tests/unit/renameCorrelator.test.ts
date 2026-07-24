import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenameCorrelator, type PendingDeletion } from '../../src/main/capture/renameCorrelator';

function deletion(overrides: Partial<PendingDeletion> = {}): PendingDeletion {
  return {
    fileId: 'file-1',
    normalizedPath: 'notes/a.md',
    displayPath: 'notes/a.md',
    contentHash: 'hash-a',
    byteSize: 100,
    ino: null,
    dev: null,
    registeredAt: Date.now(),
    ...overrides
  };
}

describe('RenameCorrelator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('claims a deletion when content hash and size match', () => {
    const correlator = new RenameCorrelator();
    correlator.register(deletion(), async () => undefined);

    const claim = correlator.claim({ contentHash: 'hash-a', byteSize: 100, ino: null, dev: null });
    expect(claim?.confidence).toBe('content_match');
    expect(claim?.deletion.fileId).toBe('file-1');
    expect(correlator.size).toBe(0);
  });

  it('prefers filesystem identity over content when available', () => {
    const correlator = new RenameCorrelator();
    correlator.register(deletion({ contentHash: 'other', ino: 42, dev: 7 }), async () => undefined);

    const claim = correlator.claim({ contentHash: 'hash-a', byteSize: 100, ino: 42, dev: 7 });
    expect(claim?.confidence).toBe('filesystem_identity');
  });

  it('ignores a zero inode, which some platforms report', () => {
    const correlator = new RenameCorrelator();
    correlator.register(deletion({ contentHash: 'other', ino: 0, dev: 0 }), async () => undefined);
    expect(correlator.claim({ contentHash: 'hash-a', byteSize: 100, ino: 0, dev: 0 })).toBeNull();
  });

  it('declines when two deletions share the same content — ambiguity is unsafe (AC-7)', () => {
    const correlator = new RenameCorrelator();
    correlator.register(deletion({ fileId: 'f1', normalizedPath: 'a.md' }), async () => undefined);
    correlator.register(deletion({ fileId: 'f2', normalizedPath: 'b.md' }), async () => undefined);

    expect(correlator.claim({ contentHash: 'hash-a', byteSize: 100, ino: null, dev: null })).toBeNull();
    expect(correlator.size).toBe(2);
  });

  it('declines when the size differs even if the hash somehow matches', () => {
    const correlator = new RenameCorrelator();
    correlator.register(deletion(), async () => undefined);
    expect(correlator.claim({ contentHash: 'hash-a', byteSize: 999, ino: null, dev: null })).toBeNull();
  });

  it('commits the tombstone when nothing claims it inside the window', async () => {
    const correlator = new RenameCorrelator({ windowMs: 2000 });
    let committed = false;
    correlator.register(deletion(), async () => {
      committed = true;
    });

    expect(committed).toBe(false);
    await vi.advanceTimersByTimeAsync(2100);
    expect(committed).toBe(true);
    expect(correlator.size).toBe(0);
  });

  it('does not commit a deletion that was claimed', async () => {
    const correlator = new RenameCorrelator({ windowMs: 2000 });
    let committed = false;
    correlator.register(deletion(), async () => {
      committed = true;
    });

    correlator.claim({ contentHash: 'hash-a', byteSize: 100, ino: null, dev: null });
    await vi.advanceTimersByTimeAsync(3000);
    expect(committed).toBe(false);
  });

  it('flush commits everything still held', async () => {
    const correlator = new RenameCorrelator();
    const committed: string[] = [];
    correlator.register(deletion({ fileId: 'f1', normalizedPath: 'a.md' }), async () => {
      committed.push('f1');
    });
    correlator.register(deletion({ fileId: 'f2', normalizedPath: 'b.md', contentHash: 'x' }), async () => {
      committed.push('f2');
    });

    await correlator.flush();
    expect(committed.sort()).toEqual(['f1', 'f2']);
    expect(correlator.size).toBe(0);
  });
});
