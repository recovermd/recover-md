/**
 * Version capture (FR-4).
 *
 * Everything that turns bytes on disk into immutable history lives here. Invariants:
 *  - the workspace is only ever *read*
 *  - identical content never creates a second version
 *  - a version and its blob are written in one transaction, so a crash leaves either the
 *    complete prior state or the complete new state (§19.5 / AC-19)
 */
import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { MAX_FILE_BYTES } from '@shared/constants';
import type {
  CaptureOrigin,
  SkippedFileReport,
  VersionEventType,
  VersionRecord
} from '@shared/types/domain';
import { BlobStore, type PreparedBlob } from '../storage/blobStore';
import type { Store } from '../storage/store';
import { computeLineStats } from '../diff/diffEngine';
import type { Logger } from '../logging/logger';
import type { IgnoreMatcher } from '../vault/ignore';
import { basenameOf, isMarkdownPath, toDisplayPath, toNormalizedPath, isInsideVault } from '../vault/paths';
import { describeError } from '../vault/scanner';
import { decodeUtf8 } from '../vault/text';

export type CaptureResult =
  | { status: 'captured'; fileId: string; version: VersionRecord }
  | { status: 'unchanged'; fileId: string }
  | { status: 'skipped'; report: SkippedFileReport }
  | { status: 'ignored'; reason: string }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export interface CaptureEmitter {
  versionCaptured(payload: { fileId: string; versionId: string; path: string }): void;
  fileStateChanged(payload: { fileId: string; status: 'active' | 'deleted'; path: string }): void;
  skippedFile(report: SkippedFileReport): void;
}

export interface CaptureServiceOptions {
  store: Store;
  vaultId: string;
  root: string;
  ignore: () => IgnoreMatcher;
  logger: Logger;
  emitter: CaptureEmitter;
  maxFileBytes?: number;
}

export interface StableRead {
  bytes: Buffer;
  stats: Stats;
}

export class CaptureService {
  private readonly maxFileBytes: number;

  constructor(private readonly options: CaptureServiceOptions) {
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  }

  private get store(): Store {
    return this.options.store;
  }

  /**
   * Reads a file and captures it if its content changed.
   *
   * `renameClaimer` lets the caller (the vault coordinator) turn an apparent new file into
   * a rename of a recently deleted one before any history is written.
   */
  async captureFromDisk(
    absolutePath: string,
    origin: CaptureOrigin,
    hooks: {
      claimRename?: (candidate: {
        contentHash: string;
        byteSize: number;
        ino: number | null;
        dev: number | null;
      }) => { fileId: string; fromDisplayPath: string } | null;
      /** Optional human-readable label, e.g. "Changed while Recover.MD was closed". */
      label?: string | null;
    } = {}
  ): Promise<CaptureResult> {
    const { root } = this.options;

    if (!isInsideVault(root, absolutePath)) {
      return { status: 'ignored', reason: 'outside_vault' };
    }
    if (!isMarkdownPath(absolutePath)) {
      return { status: 'ignored', reason: 'not_markdown' };
    }
    const displayPath = toDisplayPath(root, absolutePath);
    const normalizedPath = toNormalizedPath(root, absolutePath);
    if (this.options.ignore().ignoresFile(displayPath)) {
      return { status: 'ignored', reason: 'ignored_pattern' };
    }

    let read: StableRead;
    try {
      read = await this.readStable(absolutePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { status: 'missing' };
      if (code === 'EISDIR') return { status: 'ignored', reason: 'directory' };
      if (code === 'ERR_FILE_TOO_LARGE') {
        const report: SkippedFileReport = {
          path: displayPath,
          reason: 'too_large',
          detail: `File exceeds the ${this.maxFileBytes} byte limit.`,
          byteSize: null,
          at: Date.now()
        };
        this.recordSkip(report);
        return { status: 'skipped', report };
      }
      const report: SkippedFileReport = {
        path: displayPath,
        reason: 'unreadable',
        detail: describeError(error),
        byteSize: null,
        at: Date.now()
      };
      this.recordSkip(report);
      return { status: 'error', message: describeError(error) };
    }

    if (read.stats.size > this.maxFileBytes) {
      const report: SkippedFileReport = {
        path: displayPath,
        reason: 'too_large',
        detail: `File is ${read.stats.size} bytes; the limit is ${this.maxFileBytes} bytes.`,
        byteSize: read.stats.size,
        at: Date.now()
      };
      this.recordSkip(report);
      return { status: 'skipped', report };
    }

    // The file is readable again: drop any previous warning about it.
    this.store.skipped.clearPath(this.options.vaultId, displayPath);

    const prepared = await BlobStore.prepare(read.bytes);

    let file = this.store.files.activeByNormalizedPath(this.options.vaultId, normalizedPath);
    let eventType: VersionEventType;

    if (!file) {
      const claim = hooks.claimRename?.({
        contentHash: prepared.hash,
        byteSize: read.bytes.byteLength,
        ino: numberOrNull(read.stats.ino),
        dev: numberOrNull(read.stats.dev)
      });

      if (claim) {
        file = this.store.files.byId(claim.fileId);
        if (file) {
          this.moveFileRow(file.id, displayPath, normalizedPath);
          const renameVersion = this.commitVersion({
            fileId: file.id,
            eventType: 'rename',
            displayPath,
            prepared,
            stats: read.stats,
            origin,
            text: decodeUtf8(read.bytes),
            label: hooks.label ?? null,
            metadata: { renamedFrom: claim.fromDisplayPath }
          });
          this.options.emitter.fileStateChanged({
            fileId: file.id,
            status: 'active',
            path: displayPath
          });
          this.options.emitter.versionCaptured({
            fileId: file.id,
            versionId: renameVersion.id,
            path: displayPath
          });
          return { status: 'captured', fileId: file.id, version: renameVersion };
        }
      }
    }

    if (!file) {
      // A file reappearing at a path we previously tombstoned continues that history only
      // when its content matches what we last saw there; otherwise it is a new document.
      const previouslyDeleted = this.store.files.latestDeletedByNormalizedPath(
        this.options.vaultId,
        normalizedPath
      );
      const lastContent = previouslyDeleted
        ? this.store.versions.latestContent(previouslyDeleted.id)
        : null;

      if (previouslyDeleted && lastContent?.blobHash === prepared.hash) {
        this.store.files.setStatus(previouslyDeleted.id, 'active');
        this.store.files.setPath(previouslyDeleted.id, displayPath, normalizedPath);
        file = this.store.files.byId(previouslyDeleted.id);
        eventType = 'create';
      } else {
        file = this.store.files.create({
          vaultId: this.options.vaultId,
          currentPath: displayPath,
          normalizedPath
        });
        eventType = origin === 'initial_scan' ? 'baseline' : 'create';
      }
    } else {
      const latest = this.store.versions.latest(file.id);
      eventType = latest === null ? 'baseline' : latest.eventType === 'delete' ? 'create' : 'modify';
    }

    if (!file) return { status: 'error', message: 'file row disappeared during capture' };

    const latestContent = this.store.versions.latestContent(file.id);
    if (latestContent?.blobHash === prepared.hash && eventType === 'modify') {
      // FR-4 deduplication: identical bytes never create a second content version.
      this.store.files.touch(file.id);
      return { status: 'unchanged', fileId: file.id };
    }

    const version = this.commitVersion({
      fileId: file.id,
      eventType,
      displayPath,
      prepared,
      stats: read.stats,
      origin,
      text: decodeUtf8(read.bytes),
      label: hooks.label ?? null
    });

    if (eventType === 'create') {
      this.options.emitter.fileStateChanged({
        fileId: file.id,
        status: 'active',
        path: displayPath
      });
    }
    this.options.emitter.versionCaptured({
      fileId: file.id,
      versionId: version.id,
      path: displayPath
    });
    return { status: 'captured', fileId: file.id, version };
  }

  /**
   * Writes a tombstone (FR-8). The file's content stays available; only its presence on
   * disk changed. Returns null when there is nothing to tombstone.
   */
  recordDeletion(normalizedPath: string, origin: CaptureOrigin): VersionRecord | null {
    const file = this.store.files.activeByNormalizedPath(this.options.vaultId, normalizedPath);
    if (!file) return null;

    const latest = this.store.versions.latest(file.id);
    if (latest?.eventType === 'delete') return null;
    const lastContent = this.store.versions.latestContent(file.id);

    const version = this.store.db.transaction(() => {
      const created = this.store.versions.insert({
        fileId: file.id,
        eventType: 'delete',
        path: file.currentPath,
        sourceMtimeMs: null,
        // A tombstone references the last recoverable blob (§14.4) so recovery is a
        // single lookup rather than a scan backwards through history.
        blobHash: lastContent?.blobHash ?? null,
        byteSize: lastContent?.byteSize ?? 0,
        lineCount: lastContent?.lineCount ?? null,
        addedLines: 0,
        removedLines: lastContent?.lineCount ?? 0,
        origin
      });
      this.store.files.setStatus(file.id, 'deleted');
      this.store.files.setCurrentVersion(file.id, created.id);
      return created;
    });

    this.options.emitter.fileStateChanged({
      fileId: file.id,
      status: 'deleted',
      path: file.currentPath
    });
    this.options.emitter.versionCaptured({
      fileId: file.id,
      versionId: version.id,
      path: file.currentPath
    });
    return version;
  }

  /**
   * Stores explicit bytes as a new version. Used by restore and recovery so the write they
   * just performed is recorded as a first-class event rather than discovered by the watcher.
   */
  async captureBytes(params: {
    fileId: string;
    displayPath: string;
    bytes: Buffer;
    eventType: VersionEventType;
    origin: CaptureOrigin;
    sourceMtimeMs: number | null;
    label?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<VersionRecord> {
    const prepared = await BlobStore.prepare(params.bytes);
    const version = this.commitVersion({
      fileId: params.fileId,
      eventType: params.eventType,
      displayPath: params.displayPath,
      prepared,
      stats: null,
      sourceMtimeMs: params.sourceMtimeMs,
      origin: params.origin,
      text: decodeUtf8(params.bytes),
      label: params.label ?? null,
      metadata: params.metadata
    });
    this.options.emitter.versionCaptured({
      fileId: params.fileId,
      versionId: version.id,
      path: params.displayPath
    });
    return version;
  }

  /** Moves a tracked file to a new path, tombstoning anything already tracked there. */
  private moveFileRow(fileId: string, displayPath: string, normalizedPath: string): void {
    const occupant = this.store.files.activeByNormalizedPath(this.options.vaultId, normalizedPath);
    if (occupant && occupant.id !== fileId) {
      // The destination was overwritten by the move. Its own history is preserved.
      this.recordDeletion(occupant.normalizedPath, 'watcher');
    }
    this.store.files.setPath(fileId, displayPath, normalizedPath);
    this.store.files.setStatus(fileId, 'active');
  }

  /**
   * The single write path for content versions: blob, version row, file pointer and search
   * entry all land in one transaction.
   */
  private commitVersion(params: {
    fileId: string;
    eventType: VersionEventType;
    displayPath: string;
    prepared: PreparedBlob;
    stats: Stats | null;
    origin: CaptureOrigin;
    text: string | null;
    sourceMtimeMs?: number | null;
    label?: string | null;
    metadata?: Record<string, unknown>;
  }): VersionRecord {
    const previousContent = this.store.versions.latestContent(params.fileId);
    const previousText = previousContent?.blobHash
      ? this.decodeBlobSync(previousContent.blobHash)
      : null;
    const stats = computeLineStats(previousText, params.text);

    const metadata: Record<string, unknown> = { ...(params.metadata ?? {}) };
    if (params.stats) {
      const ino = numberOrNull(params.stats.ino);
      const dev = numberOrNull(params.stats.dev);
      if (ino !== null) metadata.ino = ino;
      if (dev !== null) metadata.dev = dev;
    }
    if (params.text === null) metadata.textUnsupported = true;

    return this.store.db.transaction(() => {
      this.store.blobs.putPreparedSync(params.prepared);
      const version = this.store.versions.insert({
        fileId: params.fileId,
        eventType: params.eventType,
        path: params.displayPath,
        sourceMtimeMs:
          params.sourceMtimeMs !== undefined
            ? params.sourceMtimeMs
            : params.stats
              ? Math.round(params.stats.mtimeMs)
              : null,
        blobHash: params.prepared.hash,
        byteSize: params.prepared.rawSize,
        lineCount: stats.lineCount,
        addedLines: stats.addedLines,
        removedLines: stats.removedLines,
        origin: params.origin,
        label: params.label ?? null,
        metadata
      });
      this.store.files.setCurrentVersion(params.fileId, version.id);
      this.store.files.touch(params.fileId);
      this.store.search.index({
        versionId: version.id,
        fileId: params.fileId,
        filename: basenameOf(params.displayPath),
        path: params.displayPath,
        content: params.text
      });
      return version;
    });
  }

  /**
   * Decompresses a stored blob synchronously.
   *
   * Line statistics are computed inside the capture path, where the transaction is about
   * to open; doing this asynchronously would mean re-reading state that may have changed.
   * Markdown blobs are small, so the cost is bounded.
   */
  private decodeBlobSync(hash: string): string | null {
    const row = this.store.db.get<{ codec: string; compressed_data: Uint8Array }>(
      'SELECT codec, compressed_data FROM blobs WHERE hash = ?',
      [hash]
    );
    if (!row) return null;
    try {
      const bytes =
        row.codec === 'identity'
          ? Buffer.from(row.compressed_data)
          : brotliDecompressSync(row.compressed_data);
      return decodeUtf8(bytes);
    } catch {
      return null;
    }
  }

  private recordSkip(report: SkippedFileReport): void {
    this.store.skipped.record(this.options.vaultId, report);
    this.options.emitter.skippedFile(report);
    this.options.logger.warn('Skipped file', { path: report.path, reason: report.reason });
  }

  /**
   * Reads a file, retrying briefly while it is still being written (§19.4). A read failure
   * never implies deletion.
   */
  private async readStable(absolutePath: string, attempts = 3): Promise<StableRead> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const before = await fs.stat(absolutePath);
        if (!before.isFile()) {
          const error: NodeJS.ErrnoException = new Error('Not a regular file');
          error.code = 'EISDIR';
          throw error;
        }
        if (before.size > this.maxFileBytes) {
          const error: NodeJS.ErrnoException = new Error('File too large');
          error.code = 'ERR_FILE_TOO_LARGE';
          throw error;
        }
        const bytes = await fs.readFile(absolutePath);
        const after = await fs.stat(absolutePath);
        if (after.size === before.size && after.mtimeMs === before.mtimeMs) {
          return { bytes, stats: after };
        }
        lastError = new Error('File changed while reading');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EISDIR' || code === 'ERR_FILE_TOO_LARGE') throw error;
        lastError = error;
      }
      await delay(50 * (attempt + 1));
    }
    throw lastError ?? new Error('Could not read file');
  }
}

function numberOrNull(value: number | bigint | undefined): number | null {
  if (value === undefined) return null;
  const asNumber = typeof value === 'bigint' ? Number(value) : value;
  return Number.isFinite(asNumber) ? asNumber : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convenience for callers that need the vault-relative path of an absolute path. */
export function relativeTo(root: string, absolutePath: string): string {
  return toDisplayPath(root, path.resolve(absolutePath));
}
