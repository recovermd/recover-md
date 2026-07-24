/**
 * End-to-end tracking through the real watcher (Milestone 4 / AC-2, 3, 6, 7, 8, 15, 16).
 *
 * These tests deliberately use real timers and the real filesystem: the behaviour under
 * test *is* the interaction between filesystem events, debouncing and capture.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventMap, EventName } from '../../src/shared/contracts/ipc';
import { HealthMonitor } from '../../src/main/health/healthMonitor';
import { createNullLogger } from '../../src/main/logging/logger';
import { Store } from '../../src/main/storage/store';
import { VaultCoordinator } from '../../src/main/vault/vaultCoordinator';
import { canonicalizeRoot } from '../../src/main/vault/paths';
import { waitFor } from '../helpers/testEnv';

interface Harness {
  root: string;
  dataDir: string;
  store: Store;
  coordinator: VaultCoordinator;
  events: { name: EventName; payload: unknown }[];
  write(relativePath: string, contents: string): Promise<string>;
  absolute(relativePath: string): string;
  versionsFor(displayPath: string): number;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.dispose();
});

async function createHarness(options: { reuse?: Harness } = {}): Promise<Harness> {
  const base = options.reuse
    ? path.dirname(options.reuse.root)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'recovermd-watch-'));
  const rawRoot = path.join(base, 'vault');
  const dataDir = path.join(base, 'data');
  await fs.mkdir(rawRoot, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const root = await canonicalizeRoot(rawRoot);

  const store = await Store.open({ dataDir });
  // Minimum allowed delay keeps these tests quick while exercising real debouncing.
  store.settings.update({ snapshotDelayMs: 1000 });

  const events: { name: EventName; payload: unknown }[] = [];
  const coordinator = new VaultCoordinator({
    store,
    logger: createNullLogger(),
    health: new HealthMonitor(),
    dataDir,
    events: {
      emit: <E extends EventName>(name: E, payload: EventMap[E]) => {
        events.push({ name, payload });
      }
    }
  });

  const harness: Harness = {
    root,
    dataDir,
    store,
    coordinator,
    events,
    absolute: (relativePath) => path.join(root, ...relativePath.split('/')),
    async write(relativePath, contents) {
      const target = path.join(root, ...relativePath.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents);
      return target;
    },
    versionsFor(displayPath) {
      const vault = coordinator.currentVault;
      if (!vault) return 0;
      const file = store.files.activeByNormalizedPath(vault.id, displayPath.toLowerCase());
      return file ? store.versions.countForFile(file.id) : 0;
    },
    async stop() {
      await coordinator.stopTracking();
    },
    async dispose() {
      await coordinator.stopTracking().catch(() => undefined);
      store.close();
    }
  };

  harnesses.push(harness);
  return harness;
}

/** Opens the vault and waits until the initial index has finished. */
async function openAndIndex(harness: Harness): Promise<void> {
  await harness.coordinator.openVault(harness.root);
  await waitFor(() => harness.coordinator.trackingState === 'active', 15_000);
}

function fileByPath(harness: Harness, displayPath: string) {
  const vault = harness.coordinator.currentVault;
  if (!vault) return null;
  return (
    harness.store.files.activeByNormalizedPath(vault.id, displayPath.toLowerCase()) ??
    harness.store.files.latestDeletedByNormalizedPath(vault.id, displayPath.toLowerCase())
  );
}

describe('live tracking', () => {
  it('captures a baseline for existing files and records later edits (AC-1, AC-2)', async () => {
    const harness = await createHarness();
    await harness.write('notes/a.md', 'first\n');
    await openAndIndex(harness);

    expect(harness.versionsFor('notes/a.md')).toBe(1);
    const baseline = harness.store.versions.latest(fileByPath(harness, 'notes/a.md')!.id);
    expect(baseline?.eventType).toBe('baseline');

    await harness.write('notes/a.md', 'first\nsecond\n');
    await waitFor(() => harness.versionsFor('notes/a.md') === 2, 10_000);

    const latest = harness.store.versions.latest(fileByPath(harness, 'notes/a.md')!.id);
    expect(latest?.eventType).toBe('modify');
    expect(latest?.origin).toBe('watcher');
    expect(latest?.addedLines).toBe(1);
  });

  it('coalesces a burst of writes into a single version (AC-3)', async () => {
    const harness = await createHarness();
    await harness.write('burst.md', 'line 0\n');
    await openAndIndex(harness);

    for (let i = 1; i <= 10; i += 1) {
      await harness.write('burst.md', `line 0\nedit ${i}\n`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    await waitFor(() => harness.versionsFor('burst.md') >= 2, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // One baseline plus one captured stable state — not ten noisy versions.
    expect(harness.versionsFor('burst.md')).toBe(2);
    const latest = harness.store.versions.latest(fileByPath(harness, 'burst.md')!.id);
    expect((await harness.store.blobs.get(latest!.blobHash!))?.toString('utf8')).toBe(
      'line 0\nedit 10\n'
    );
  });

  it('reads an atomic save as a modification, not a delete plus create (AC-6)', async () => {
    const harness = await createHarness();
    await harness.write('atomic.md', 'original\n');
    await openAndIndex(harness);

    const fileId = fileByPath(harness, 'atomic.md')!.id;

    // The temp-file dance most editors perform.
    const temporary = harness.absolute('atomic.md.tmp');
    await fs.writeFile(temporary, 'replaced by an editor\n');
    await fs.rename(temporary, harness.absolute('atomic.md'));

    await waitFor(() => harness.versionsFor('atomic.md') === 2, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const versions = harness.store.versions.listForFile(fileId);
    expect(versions.map((version) => version.eventType)).not.toContain('delete');
    expect(versions[0]?.eventType).toBe('modify');
    expect(fileByPath(harness, 'atomic.md')?.status).toBe('active');
  });

  it('tombstones a deleted file and keeps its content recoverable (AC-8)', async () => {
    const harness = await createHarness();
    await harness.write('doomed.md', 'valuable content\n');
    await openAndIndex(harness);
    const fileId = fileByPath(harness, 'doomed.md')!.id;

    await fs.rm(harness.absolute('doomed.md'));

    await waitFor(
      () => harness.store.versions.latest(fileId)?.eventType === 'delete',
      15_000
    );

    const tombstone = harness.store.versions.latest(fileId);
    expect(harness.store.files.byId(fileId)?.status).toBe('deleted');
    const bytes = await harness.store.blobs.get(tombstone!.blobHash!);
    expect(bytes?.toString('utf8')).toBe('valuable content\n');
  });

  it('keeps one timeline across a rename (AC-7)', async () => {
    const harness = await createHarness();
    await harness.write('before.md', 'content that moves\n');
    await openAndIndex(harness);
    const fileId = fileByPath(harness, 'before.md')!.id;

    await fs.rename(harness.absolute('before.md'), harness.absolute('after.md'));

    await waitFor(() => {
      const latest = harness.store.versions.latest(fileId);
      return latest?.eventType === 'rename' || latest?.eventType === 'delete';
    }, 15_000);

    const latest = harness.store.versions.latest(fileId);
    expect(latest?.eventType).toBe('rename');
    expect(latest?.path).toBe('after.md');
    expect(harness.store.files.byId(fileId)?.currentPath).toBe('after.md');
    expect(harness.store.files.byId(fileId)?.status).toBe('active');
  });

  it('ignores files that match the exclusion rules', async () => {
    const harness = await createHarness();
    await harness.write('.git/notes.md', 'should not be tracked\n');
    await harness.write('node_modules/pkg/readme.md', 'should not be tracked\n');
    await harness.write('real.md', 'tracked\n');
    await openAndIndex(harness);

    const vault = harness.coordinator.currentVault!;
    expect(harness.store.files.count(vault.id)).toBe(1);
    expect(harness.versionsFor('real.md')).toBe(1);
  });

  it('does not record changes while tracking is paused, and catches up on resume', async () => {
    const harness = await createHarness();
    await harness.write('paused.md', 'one\n');
    await openAndIndex(harness);

    await harness.coordinator.pauseTracking();
    await harness.write('paused.md', 'one\ntwo\n');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(harness.versionsFor('paused.md')).toBe(1);

    await harness.coordinator.resumeTracking();
    expect(harness.versionsFor('paused.md')).toBe(2);
    const latest = harness.store.versions.latest(fileByPath(harness, 'paused.md')!.id);
    expect(latest?.origin).toBe('startup_reconciliation');
  });
});

describe('reconciliation', () => {
  it('captures the latest state of a file changed while stopped, labelled honestly (AC-16)', async () => {
    const harness = await createHarness();
    await harness.write('offline.md', 'before shutdown\n');
    await openAndIndex(harness);
    expect(harness.versionsFor('offline.md')).toBe(1);

    await harness.stop();

    // Two edits while nothing is watching: only the latest state is recoverable.
    await harness.write('offline.md', 'intermediate edit\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await harness.write('offline.md', 'final edit\n');
    await harness.write('created-offline.md', 'brand new\n');
    await fs.rm(harness.absolute('offline.md') + '.missing').catch(() => undefined);

    await openAndIndex(harness);

    const fileId = fileByPath(harness, 'offline.md')!.id;
    const versions = harness.store.versions.listForFile(fileId);
    expect(versions).toHaveLength(2);

    const latest = versions[0]!;
    expect(latest.origin).toBe('startup_reconciliation');
    expect(latest.label).toBe('Changed while Recover.MD was closed');
    expect((await harness.store.blobs.get(latest.blobHash!))?.toString('utf8')).toBe('final edit\n');

    // The intermediate edit is genuinely gone — the product must not pretend otherwise.
    const contents = await Promise.all(
      versions.map((version) => harness.store.blobs.get(version.blobHash!))
    );
    expect(contents.map((buffer) => buffer?.toString('utf8'))).not.toContain('intermediate edit\n');

    expect(harness.versionsFor('created-offline.md')).toBe(1);
  });

  it('records a deletion that happened while stopped', async () => {
    const harness = await createHarness();
    await harness.write('vanished.md', 'here\n');
    await openAndIndex(harness);
    const fileId = fileByPath(harness, 'vanished.md')!.id;

    await harness.stop();
    await fs.rm(harness.absolute('vanished.md'));
    await openAndIndex(harness);

    const latest = harness.store.versions.latest(fileId);
    expect(latest?.eventType).toBe('delete');
    expect(latest?.origin).toBe('startup_reconciliation');
    expect(harness.store.files.byId(fileId)?.status).toBe('deleted');
  });

  it('does not re-capture unchanged files on restart', async () => {
    const harness = await createHarness();
    await harness.write('stable.md', 'unchanged\n');
    await openAndIndex(harness);
    expect(harness.versionsFor('stable.md')).toBe(1);

    await harness.stop();
    await openAndIndex(harness);

    expect(harness.versionsFor('stable.md')).toBe(1);
  });
});

describe('event stream', () => {
  it('emits tracking state and version events for the renderer', async () => {
    const harness = await createHarness();
    await harness.write('a.md', 'one\n');
    await openAndIndex(harness);

    const names = harness.events.map((event) => event.name);
    expect(names).toContain('trackingStateChanged');
    expect(names).toContain('versionCaptured');
    expect(names).toContain('indexProgress');
  });
});
