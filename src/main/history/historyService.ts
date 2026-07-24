/**
 * Read-side services for the timeline, previews and diffs (FR-5, FR-6).
 *
 * Pure queries: nothing here writes to the database or the workspace.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  DiffResult,
  StorageUsage,
  TimelineEntry,
  TimelineGroup,
  TimelineGroupKey,
  VersionContent
} from '@shared/types/domain';
import type { DiffRequest } from '@shared/contracts/ipc';
import type { DiffWorkerClient } from '../diff/diffWorkerClient';
import { hashBytes } from '../storage/blobStore';
import type { Store } from '../storage/store';
import { decodeUtf8, hasUtf8Bom } from '../vault/text';

export interface HistoryServiceOptions {
  store: Store;
  diff: DiffWorkerClient;
  /** Resolves a vault-relative display path to an absolute path, when a vault is open. */
  resolvePath: (displayPath: string) => string | null;
}

export class HistoryService {
  constructor(private readonly options: HistoryServiceOptions) {}

  private get store(): Store {
    return this.options.store;
  }

  /** Chronological timeline, grouped for display (FR-5). */
  getTimeline(fileId: string, limit = 500, offset = 0, now = new Date()): TimelineGroup[] {
    const file = this.store.files.byId(fileId);
    if (!file) return [];

    const versions = this.store.versions.listForFile(fileId, limit, offset);
    const groups = new Map<TimelineGroupKey, TimelineEntry[]>();

    for (const version of versions) {
      const isCurrent = file.currentVersionId === version.id;
      const entry: TimelineEntry = {
        ...version,
        isCurrent,
        previousPath: version.path === file.currentPath ? null : version.path,
        textUnsupported: version.metadata.textUnsupported === true
      };
      const key = isCurrent ? 'current' : bucketFor(version.capturedAt, now);
      const bucket = groups.get(key);
      if (bucket) bucket.push(entry);
      else groups.set(key, [entry]);
    }

    const order: TimelineGroupKey[] = ['current', 'today', 'yesterday', 'this_week', 'older'];
    return order
      .filter((key) => groups.has(key))
      .map((key) => ({ key, entries: groups.get(key) ?? [] }));
  }

  /** Exact stored bytes of a version, plus a decoded view when the bytes are text. */
  async getVersionContent(versionId: string): Promise<VersionContent | null> {
    const version = this.store.versions.byId(versionId);
    if (!version) return null;
    if (!version.blobHash) {
      return {
        versionId,
        contentBase64: '',
        text: null,
        byteSize: 0,
        hash: null,
        encodingSupported: false,
        hasBom: false
      };
    }
    const bytes = await this.store.blobs.get(version.blobHash);
    if (!bytes) return null;
    const text = decodeUtf8(bytes);
    return {
      versionId,
      contentBase64: bytes.toString('base64'),
      text,
      byteSize: bytes.byteLength,
      hash: version.blobHash,
      encodingSupported: text !== null,
      hasBom: hasUtf8Bom(bytes)
    };
  }

  /**
   * The file as it exists on disk right now. Falls back to the latest stored version when
   * the file is deleted or unreadable, so the UI always has something to show.
   */
  async getCurrentContent(fileId: string): Promise<VersionContent | null> {
    const file = this.store.files.byId(fileId);
    if (!file) return null;

    const absolute = this.options.resolvePath(file.currentPath);
    if (absolute && file.status === 'active') {
      const bytes = await fs.readFile(absolute).catch(() => null);
      if (bytes) {
        const text = decodeUtf8(bytes);
        return {
          versionId: file.currentVersionId ?? '',
          contentBase64: bytes.toString('base64'),
          text,
          byteSize: bytes.byteLength,
          hash: hashBytes(bytes),
          encodingSupported: text !== null,
          hasBom: hasUtf8Bom(bytes)
        };
      }
    }

    const latest = this.store.versions.latestContent(fileId);
    return latest ? this.getVersionContent(latest.id) : null;
  }

  /** Diff of a version against its predecessor or against the current file (FR-6). */
  async getDiff(request: DiffRequest): Promise<DiffResult> {
    const version = this.store.versions.byId(request.versionId);
    if (!version) {
      return { lines: [], addedLines: 0, removedLines: 0, truncated: false, unsupported: true };
    }

    const selected = version.blobHash ? await this.store.blobs.get(version.blobHash) : null;
    const selectedText = selected ? decodeUtf8(selected) : null;

    if (request.compareWith === 'current') {
      const current = await this.getCurrentContent(version.fileId);
      return this.options.diff.diff(selectedText, current?.text ?? null);
    }

    const previous = this.store.versions.previousContent(version.fileId, version.sequence);
    const previousBytes = previous?.blobHash ? await this.store.blobs.get(previous.blobHash) : null;
    const previousText = previousBytes ? decodeUtf8(previousBytes) : null;

    // The first version of a file has no predecessor: compare against an empty document so
    // the diff reads as "everything was added" rather than failing.
    return this.options.diff.diff(previous ? previousText : '', selectedText);
  }

  async getStorageUsage(): Promise<StorageUsage> {
    const blobStats = this.store.blobs.stats();
    const [databaseBytes, backupBytes] = await Promise.all([
      this.store.databaseBytes(),
      this.store.backups.totalBytes().catch(() => 0)
    ]);
    const fileCount =
      this.store.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM files')?.n ?? 0;

    return {
      databaseBytes,
      blobCount: blobStats.count,
      blobRawBytes: blobStats.rawBytes,
      blobCompressedBytes: blobStats.compressedBytes,
      versionCount: this.store.versions.total(),
      fileCount,
      backupBytes
    };
  }
}

/** Timeline buckets use the local calendar, not fixed 24-hour windows (FR-5). */
export function bucketFor(timestamp: number, now: Date): TimelineGroupKey {
  const date = new Date(timestamp);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 6 * 24 * 60 * 60 * 1000;

  if (date.getTime() >= startOfToday) return 'today';
  if (date.getTime() >= startOfYesterday) return 'yesterday';
  if (date.getTime() >= startOfWeek) return 'this_week';
  return 'older';
}

/** Absolute path helper shared with the restore service. */
export function joinVaultPath(root: string, displayPath: string): string {
  return path.join(root, ...displayPath.split('/'));
}
