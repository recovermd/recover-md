/**
 * Restore and deleted-file recovery (FR-7, FR-8).
 *
 * Restore is the only operation that writes to the user's workspace, so it is also the
 * most defensive code in the product:
 *
 *  - the stored bytes are verified against their hash before anything is written
 *  - the current on-disk state is captured first, so a restore is itself reversible
 *  - a file that changed after the dialog opened is never overwritten silently (AC-12)
 *  - newer history is never deleted; a restore *appends* a restore event (AC-11)
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  RecoverOutcome,
  RecoverRequest,
  RestoreOutcome,
  RestoreRequest
} from '@shared/types/domain';
import type { CaptureService } from '../capture/captureService';
import { hashBytes } from '../storage/blobStore';
import type { Store } from '../storage/store';
import type { HealthMonitor } from '../health/healthMonitor';
import type { Logger } from '../logging/logger';
import { isSafeWriteTarget, recoveryCandidateName, toNormalizedPath } from '../vault/paths';
import { atomicWriteFile, readMode } from './atomicWrite';

export interface RestoreServiceOptions {
  store: Store;
  logger: Logger;
  health: HealthMonitor;
  /** Supplies the live capture service and vault root; null when no vault is tracked. */
  context: () => {
    root: string;
    vaultId: string;
    capture: CaptureService;
    suppressWatcher: (normalizedPath: string) => void;
  } | null;
}

export class RestoreService {
  constructor(private readonly options: RestoreServiceOptions) {}

  /** Full-file restore of a historical version. */
  async restore(request: RestoreRequest): Promise<RestoreOutcome> {
    const context = this.options.context();
    if (!context) return { status: 'failed', reason: 'No vault is being tracked.', path: '' };
    if (this.options.store.safeMode) {
      return { status: 'failed', reason: 'The database is in read-only safe mode.', path: '' };
    }

    const version = this.options.store.versions.byId(request.versionId);
    if (!version) return { status: 'failed', reason: 'That version no longer exists.', path: '' };
    if (!version.blobHash) {
      return { status: 'failed', reason: 'That version has no recoverable content.', path: version.path };
    }

    const file = this.options.store.files.byId(version.fileId);
    if (!file) return { status: 'failed', reason: 'That file is no longer tracked.', path: version.path };

    const destination = path.join(context.root, ...file.currentPath.split('/'));
    if (!(await isSafeWriteTarget(context.root, destination))) {
      return { status: 'failed', reason: 'The destination is outside the vault.', path: file.currentPath };
    }

    const bytes = await this.options.store.blobs.get(version.blobHash).catch(() => null);
    if (!bytes || hashBytes(bytes) !== version.blobHash) {
      return {
        status: 'failed',
        reason: 'The stored content failed verification and was not written.',
        path: file.currentPath
      };
    }

    const current = await readCurrent(destination);
    const currentHash = current ? hashBytes(current.bytes) : null;

    // AC-12: the file changed since the dialog opened — require a fresh confirmation.
    if (!request.force && currentHash !== request.expectedCurrentHash) {
      return { status: 'conflict', currentHash, path: file.currentPath };
    }

    if (currentHash === version.blobHash) {
      return { status: 'noop', reason: 'identical', path: file.currentPath };
    }

    // Record whatever is on disk right now, if it is not already history (FR-7 preflight).
    if (current) {
      const latestContent = this.options.store.versions.latestContent(file.id);
      if (latestContent?.blobHash !== currentHash) {
        await context.capture.captureBytes({
          fileId: file.id,
          displayPath: file.currentPath,
          bytes: current.bytes,
          eventType: 'modify',
          origin: 'restore',
          sourceMtimeMs: Math.round(current.mtimeMs),
          label: 'State before restore'
        });
      }
    }

    const free = await this.options.health.checkDiskSpace(path.dirname(destination));
    if (free !== null && free < bytes.byteLength * 2) {
      return { status: 'failed', reason: 'Not enough free disk space to restore.', path: file.currentPath };
    }

    const normalized = toNormalizedPath(context.root, destination);
    context.suppressWatcher(normalized);

    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await atomicWriteFile(destination, bytes, { mode: await readMode(destination) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error('Restore write failed', { path: file.currentPath, error: message });
      return { status: 'failed', reason: message, path: file.currentPath };
    }

    const stat = await fs.stat(destination).catch(() => null);
    this.options.store.files.setStatus(file.id, 'active');
    await context.capture.captureBytes({
      fileId: file.id,
      displayPath: file.currentPath,
      bytes,
      eventType: 'restore',
      origin: 'restore',
      sourceMtimeMs: stat ? Math.round(stat.mtimeMs) : null,
      label: `Restored version ${version.sequence}`,
      metadata: { restoredFromVersionId: version.id, restoredFromSequence: version.sequence }
    });

    this.options.logger.info('Restored version', {
      path: file.currentPath,
      sequence: version.sequence
    });
    return { status: 'restored', versionId: version.id, path: file.currentPath };
  }

  /** Recovers a deleted file from any of its stored versions (FR-8). */
  async recoverDeleted(request: RecoverRequest): Promise<RecoverOutcome> {
    const context = this.options.context();
    if (!context) return { status: 'failed', reason: 'No vault is being tracked.', path: '' };
    if (this.options.store.safeMode) {
      return { status: 'failed', reason: 'The database is in read-only safe mode.', path: '' };
    }

    const version = this.options.store.versions.byId(request.versionId);
    if (!version?.blobHash) {
      return { status: 'failed', reason: 'That version has no recoverable content.', path: version?.path ?? '' };
    }
    const file = this.options.store.files.byId(version.fileId);
    if (!file) return { status: 'failed', reason: 'That file is no longer tracked.', path: version.path };

    const bytes = await this.options.store.blobs.get(version.blobHash).catch(() => null);
    if (!bytes || hashBytes(bytes) !== version.blobHash) {
      return { status: 'failed', reason: 'The stored content failed verification.', path: file.currentPath };
    }

    let destination = path.join(context.root, ...file.currentPath.split('/'));
    let displayPath = file.currentPath;

    const parent = path.dirname(destination);
    const parentExists = await fs
      .stat(parent)
      .then((stat) => stat.isDirectory())
      .catch(() => false);
    if (!parentExists) {
      if (!request.createParentDirectories) {
        return { status: 'missing_parent', path: displayPath };
      }
      await fs.mkdir(parent, { recursive: true });
    }

    const occupied = await fs
      .stat(destination)
      .then(() => true)
      .catch(() => false);

    if (occupied) {
      if (request.onConflict === 'fail') {
        const suggestion = await this.findFreeName(destination);
        return {
          status: 'path_occupied',
          path: displayPath,
          suggestedPath: path.relative(context.root, suggestion).split(path.sep).join('/')
        };
      }
      if (request.onConflict === 'rename') {
        destination = await this.findFreeName(destination);
        displayPath = path.relative(context.root, destination).split(path.sep).join('/');
      } else {
        // Explicit replacement: preserve what is there today before overwriting it.
        const existing = await readCurrent(destination);
        if (existing) {
          const occupantNormalized = toNormalizedPath(context.root, destination);
          const occupant = this.options.store.files.activeByNormalizedPath(
            context.vaultId,
            occupantNormalized
          );
          if (occupant && occupant.id !== file.id) {
            await context.capture.captureBytes({
              fileId: occupant.id,
              displayPath: occupant.currentPath,
              bytes: existing.bytes,
              eventType: 'modify',
              origin: 'recovery',
              sourceMtimeMs: Math.round(existing.mtimeMs),
              label: 'State before recovery replaced this file'
            });
            // The occupant no longer exists at this path. Tombstone it so its history stays
            // intact and the path is free for the file being recovered.
            context.capture.recordDeletion(occupantNormalized, 'recovery');
          }
        }
      }
    }

    if (!(await isSafeWriteTarget(context.root, destination))) {
      return { status: 'failed', reason: 'The destination is outside the vault.', path: displayPath };
    }

    const normalized = toNormalizedPath(context.root, destination);
    context.suppressWatcher(normalized);

    try {
      await atomicWriteFile(destination, bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error('Recovery write failed', { path: displayPath, error: message });
      return { status: 'failed', reason: message, path: displayPath };
    }

    if (displayPath !== file.currentPath) {
      this.options.store.files.setPath(file.id, displayPath, normalized);
    }
    this.options.store.files.setStatus(file.id, 'active');

    const stat = await fs.stat(destination).catch(() => null);
    await context.capture.captureBytes({
      fileId: file.id,
      displayPath,
      bytes,
      eventType: 'recover',
      origin: 'recovery',
      sourceMtimeMs: stat ? Math.round(stat.mtimeMs) : null,
      label: `Recovered version ${version.sequence}`,
      metadata: { recoveredFromVersionId: version.id }
    });

    this.options.logger.info('Recovered deleted file', { path: displayPath });
    return { status: 'recovered', path: displayPath };
  }

  /** `note (recovered).md`, `note (recovered 2).md`, … (FR-8). */
  private async findFreeName(destination: string): Promise<string> {
    const directory = path.dirname(destination);
    const base = path.basename(destination);
    for (let attempt = 1; attempt < 100; attempt += 1) {
      const candidate = path.join(directory, recoveryCandidateName(base, attempt));
      const exists = await fs
        .stat(candidate)
        .then(() => true)
        .catch(() => false);
      if (!exists) return candidate;
    }
    return path.join(directory, recoveryCandidateName(base, Date.now()));
  }
}

async function readCurrent(
  filePath: string
): Promise<{ bytes: Buffer; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    const bytes = await fs.readFile(filePath);
    return { bytes, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}
