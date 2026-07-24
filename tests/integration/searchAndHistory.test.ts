/** Historical search and the read-side services (Milestones 6 and 8). */
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { DiffWorkerClient } from '../../src/main/diff/diffWorkerClient';
import { HistoryService } from '../../src/main/history/historyService';
import { createNullLogger } from '../../src/main/logging/logger';
import { SearchService } from '../../src/main/search/searchService';
import { createTestEnv, type TestEnv } from '../helpers/testEnv';

let env: TestEnv;

afterEach(async () => {
  await env?.cleanup();
});

function services(current: TestEnv): { search: SearchService; history: HistoryService } {
  const logger = createNullLogger();
  // No worker in tests: the client falls back to computing diffs in-process.
  const diff = new DiffWorkerClient({ workerPath: null, logger });
  return {
    search: new SearchService(current.store, logger),
    history: new HistoryService({
      store: current.store,
      diff,
      resolvePath: (displayPath) => current.absolute(displayPath)
    })
  };
}

describe('historical search', () => {
  it('finds text that only exists in an older version (AC-14)', async () => {
    env = await createTestEnv();
    const { search } = services(env);

    const target = await env.writeFile('pricing.md', '# Pricing\n\nEnterprise tier costs 4900 EUR\n');
    await env.capture.captureFromDisk(target, 'initial_scan');

    await env.writeFile('pricing.md', '# Pricing\n\nContact sales\n');
    await env.capture.captureFromDisk(target, 'watcher');

    // The removed sentence is gone from disk but must still be findable.
    expect((await env.readFile('pricing.md')).toString()).not.toContain('4900');

    const results = search.search({ text: 'Enterprise tier', scope: 'all' });
    expect(results.groups).toHaveLength(1);
    expect(results.groups[0]?.matches[0]?.snippet.toLowerCase()).toContain('enterprise');

    const historical = search.search({ text: 'Enterprise tier', scope: 'historical' });
    expect(historical.groups).toHaveLength(1);
  });

  it('searches filenames and paths as well as content', async () => {
    env = await createTestEnv();
    const { search } = services(env);
    const target = await env.writeFile('projects/roadmap.md', 'unrelated body text\n');
    await env.capture.captureFromDisk(target, 'initial_scan');

    expect(search.search({ text: 'roadmap', scope: 'all' }).groups).toHaveLength(1);
    expect(search.search({ text: 'projects', scope: 'all' }).groups).toHaveLength(1);
  });

  it('finds content in deleted files and reports them as deleted', async () => {
    env = await createTestEnv();
    const { search } = services(env);

    const target = await env.writeFile('gone.md', 'a memorable phrase\n');
    await env.capture.captureFromDisk(target, 'initial_scan');
    await fs.rm(target);
    env.capture.recordDeletion('gone.md', 'watcher');

    const results = search.search({ text: 'memorable phrase', scope: 'deleted' });
    expect(results.groups).toHaveLength(1);
    expect(results.groups[0]?.fileStatus).toBe('deleted');
    expect(results.groups[0]?.matches[0]?.versionId).toBeDefined();
  });

  it('rebuilds the index from stored versions without losing history', async () => {
    env = await createTestEnv();
    const { search } = services(env);

    const target = await env.writeFile('a.md', 'findable content\n');
    await env.capture.captureFromDisk(target, 'initial_scan');

    env.store.db.transaction(() => env.store.search.clear());
    expect(search.search({ text: 'findable', scope: 'all' }).groups).toHaveLength(0);

    const result = await search.rebuildIndex();
    expect(result.indexedVersions).toBe(1);
    expect(search.search({ text: 'findable', scope: 'all' }).groups).toHaveLength(1);
    expect(env.store.settings.isSearchIndexStale()).toBe(false);
  });

  it('tolerates FTS metacharacters in user input', () => {
    return (async () => {
      env = await createTestEnv();
      const { search } = services(env);
      const target = await env.writeFile('a.md', 'normal content\n');
      await env.capture.captureFromDisk(target, 'initial_scan');

      for (const text of ['"', 'NEAR(', 'a AND OR', '*', 'foo -bar', '(((']) {
        expect(() => search.search({ text, scope: 'all' })).not.toThrow();
      }
    })();
  });

  it('returns nothing for an empty query rather than everything', async () => {
    env = await createTestEnv();
    const { search } = services(env);
    const target = await env.writeFile('a.md', 'content\n');
    await env.capture.captureFromDisk(target, 'initial_scan');

    expect(search.search({ text: '   ', scope: 'all' }).groups).toHaveLength(0);
  });
});

describe('timeline and diff', () => {
  it('groups a timeline and marks the current version', async () => {
    env = await createTestEnv();
    const { history } = services(env);

    const target = await env.writeFile('a.md', 'one\n');
    const first = await env.capture.captureFromDisk(target, 'initial_scan');
    if (first.status !== 'captured') throw new Error('expected capture');
    await env.writeFile('a.md', 'one\ntwo\n');
    await env.capture.captureFromDisk(target, 'watcher');

    const timeline = history.getTimeline(first.fileId);
    const entries = timeline.flatMap((group) => group.entries);

    expect(entries).toHaveLength(2);
    expect(timeline[0]?.key).toBe('current');
    expect(entries.filter((entry) => entry.isCurrent)).toHaveLength(1);
    expect(entries[0]?.sequence).toBe(2);
  });

  it('diffs a version against its predecessor and against the current file (FR-6)', async () => {
    env = await createTestEnv();
    const { history } = services(env);

    const target = await env.writeFile('a.md', 'one\ntwo\n');
    const first = await env.capture.captureFromDisk(target, 'initial_scan');
    if (first.status !== 'captured') throw new Error('expected capture');

    await env.writeFile('a.md', 'one\ntwo\nthree\n');
    const second = await env.capture.captureFromDisk(target, 'watcher');
    if (second.status !== 'captured') throw new Error('expected capture');

    const versusPrevious = await history.getDiff({
      versionId: second.version.id,
      compareWith: 'previous'
    });
    expect(versusPrevious.addedLines).toBe(1);
    expect(versusPrevious.removedLines).toBe(0);

    // Change the file on disk without capturing it.
    await env.writeFile('a.md', 'one\n');
    const versusCurrent = await history.getDiff({
      versionId: first.version.id,
      compareWith: 'current'
    });
    expect(versusCurrent.removedLines).toBe(1);
  });

  it('treats the first version as an addition of every line', async () => {
    env = await createTestEnv();
    const { history } = services(env);
    const target = await env.writeFile('a.md', 'one\ntwo\n');
    const first = await env.capture.captureFromDisk(target, 'initial_scan');
    if (first.status !== 'captured') throw new Error('expected capture');

    const diff = await history.getDiff({ versionId: first.version.id, compareWith: 'previous' });
    expect(diff.addedLines).toBe(2);
    expect(diff.removedLines).toBe(0);
  });

  it('returns exact bytes and a decoded view for a version (AC-13)', async () => {
    env = await createTestEnv();
    const { history } = services(env);
    const original = Buffer.from('para one\n\npara two\n', 'utf8');
    const target = await env.writeFile('a.md', original);
    const first = await env.capture.captureFromDisk(target, 'initial_scan');
    if (first.status !== 'captured') throw new Error('expected capture');

    const content = await history.getVersionContent(first.version.id);
    expect(content?.text).toBe(original.toString('utf8'));
    expect(Buffer.from(content!.contentBase64, 'base64').equals(original)).toBe(true);
    expect(content?.encodingSupported).toBe(true);
  });

  it('reports storage usage', async () => {
    env = await createTestEnv();
    const { history } = services(env);
    const target = await env.writeFile('a.md', 'content\n');
    await env.capture.captureFromDisk(target, 'initial_scan');

    const usage = await history.getStorageUsage();
    expect(usage.versionCount).toBe(1);
    expect(usage.blobCount).toBe(1);
    expect(usage.databaseBytes).toBeGreaterThan(0);
  });
});
