/** Shared fixtures: a real temporary vault plus a real SQLite store. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CaptureService, type CaptureEmitter } from '../../src/main/capture/captureService';
import { createNullLogger } from '../../src/main/logging/logger';
import { Store } from '../../src/main/storage/store';
import { createIgnoreMatcher } from '../../src/main/vault/ignore';
import { canonicalizeRoot } from '../../src/main/vault/paths';

export interface TestEnv {
  root: string;
  dataDir: string;
  store: Store;
  vaultId: string;
  capture: CaptureService;
  events: {
    versions: { fileId: string; versionId: string; path: string }[];
    states: { fileId: string; status: string; path: string }[];
    skipped: { path: string; reason: string }[];
  };
  writeFile(relativePath: string, contents: string | Uint8Array): Promise<string>;
  readFile(relativePath: string): Promise<Buffer>;
  absolute(relativePath: string): string;
  cleanup(): Promise<void>;
}

export async function createTestEnv(options: { maxFileBytes?: number } = {}): Promise<TestEnv> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'recovermd-test-'));
  const rawRoot = path.join(base, 'vault');
  const dataDir = path.join(base, 'data');
  await fs.mkdir(rawRoot, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const root = await canonicalizeRoot(rawRoot);

  const store = await Store.open({ dataDir });
  const vault = store.vaults.upsert(root, root);

  const events: TestEnv['events'] = { versions: [], states: [], skipped: [] };
  const emitter: CaptureEmitter = {
    versionCaptured: (payload) => events.versions.push(payload),
    fileStateChanged: (payload) => events.states.push(payload),
    skippedFile: (report) => events.skipped.push({ path: report.path, reason: report.reason })
  };

  const capture = new CaptureService({
    store,
    vaultId: vault.id,
    root,
    ignore: () => createIgnoreMatcher(),
    logger: createNullLogger(),
    emitter,
    maxFileBytes: options.maxFileBytes
  });

  return {
    root,
    dataDir,
    store,
    vaultId: vault.id,
    capture,
    events,
    absolute: (relativePath) => path.join(root, ...relativePath.split('/')),
    async writeFile(relativePath, contents) {
      const target = path.join(root, ...relativePath.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents);
      return target;
    },
    async readFile(relativePath) {
      return fs.readFile(path.join(root, ...relativePath.split('/')));
    },
    async cleanup() {
      store.close();
      await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

/** Waits until `predicate` is true, polling. Keeps timing-sensitive tests readable. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
