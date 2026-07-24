/**
 * Reconciliation (FR-3).
 *
 * Compares the vault on disk with what Recover.MD believes, and captures the difference.
 * Runs at startup, after wake, after a watcher restart and periodically.
 *
 * Honest limitation, stated in the UI as well: reconciliation can only recover the *latest*
 * state of a file that changed while Recover.MD was not running. Intermediate edits are gone
 * (AC-16).
 */
import type { CaptureOrigin } from '@shared/types/domain';
import type { Store } from '../storage/store';
import type { IgnoreMatcher } from '../vault/ignore';
import { scanVault } from '../vault/scanner';
import type { CaptureService } from './captureService';

export interface ReconcileOptions {
  store: Store;
  vaultId: string;
  root: string;
  ignore: IgnoreMatcher;
  capture: CaptureService;
  origin: CaptureOrigin;
  label?: string | null;
  excludedAbsolutePaths?: readonly string[];
  onProgress?: (progress: { processed: number; total: number; currentPath: string | null }) => void;
  /** Stop early (tracking paused or app quitting). */
  shouldStop?: () => boolean;
}

export interface ReconcileReport {
  scanned: number;
  captured: number;
  unchanged: number;
  deleted: number;
  skipped: number;
}

export async function reconcileVault(options: ReconcileOptions): Promise<ReconcileReport> {
  const report: ReconcileReport = { scanned: 0, captured: 0, unchanged: 0, deleted: 0, skipped: 0 };
  const seen = new Set<string>();

  // Phase 1: enumerate, so progress has a meaningful denominator.
  const discovered: {
    absolutePath: string;
    displayPath: string;
    normalizedPath: string;
    byteSize: number;
    mtimeMs: number;
  }[] = [];
  for await (const file of scanVault({
    root: options.root,
    ignore: options.ignore,
    excludedAbsolutePaths: options.excludedAbsolutePaths,
    onSkipped: (skip) => {
      report.skipped += 1;
      options.store.skipped.record(options.vaultId, skip);
    }
  })) {
    if (options.shouldStop?.()) return report;
    discovered.push(file);
    if (discovered.length % 250 === 0) {
      options.onProgress?.({ processed: 0, total: discovered.length, currentPath: file.displayPath });
    }
  }

  // Phase 2: capture whatever changed.
  for (const file of discovered) {
    if (options.shouldStop?.()) return report;
    report.scanned += 1;
    seen.add(file.normalizedPath);

    const existing = options.store.files.activeByNormalizedPath(options.vaultId, file.normalizedPath);
    if (existing) {
      const latest = options.store.versions.latestContent(existing.id);
      const unchangedOnDisk =
        latest !== null &&
        latest.byteSize === file.byteSize &&
        latest.sourceMtimeMs !== null &&
        Math.abs(latest.sourceMtimeMs - file.mtimeMs) < 1;
      if (unchangedOnDisk) {
        report.unchanged += 1;
        options.store.files.touch(existing.id);
        options.onProgress?.({
          processed: report.scanned,
          total: discovered.length,
          currentPath: file.displayPath
        });
        continue;
      }
    }

    const result = await options.capture.captureFromDisk(file.absolutePath, options.origin, {
      label: options.label ?? null
    });
    if (result.status === 'captured') report.captured += 1;
    else if (result.status === 'unchanged') report.unchanged += 1;
    else if (result.status === 'skipped') report.skipped += 1;

    options.onProgress?.({
      processed: report.scanned,
      total: discovered.length,
      currentPath: file.displayPath
    });
  }

  // Phase 3: anything tracked as active but absent from disk is a deletion we missed.
  for (const tracked of options.store.files.listActive(options.vaultId)) {
    if (options.shouldStop?.()) return report;
    if (seen.has(tracked.normalizedPath)) continue;
    const version = options.capture.recordDeletion(tracked.normalizedPath, options.origin);
    if (version) report.deleted += 1;
  }

  return report;
}
