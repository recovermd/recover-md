/**
 * Vault lifecycle orchestrator (FR-1, FR-3, FR-10).
 *
 * Owns the tracking state machine and wires the watcher, capture queue, rename correlator
 * and reconciler together. Everything above it (IPC, tray, UI) only asks this object for
 * status and issues commands; everything below it stays unaware of the app shell.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CAPTURE_CONCURRENCY,
  DELETE_GRACE_MS,
  MAX_CONTINUOUS_EDIT_INTERVAL_MS,
  PERIODIC_RECONCILE_INTERVAL_MS,
  RENAME_CORRELATION_WINDOW_MS
} from '@shared/constants';
import type { EventMap, EventName } from '@shared/contracts/ipc';
import type {
  IndexProgress,
  TrackingState,
  VaultRecord,
  VaultStatus
} from '@shared/types/domain';
import { CaptureQueue, type QueuedTask } from '../capture/captureQueue';
import { CaptureService } from '../capture/captureService';
import { reconcileVault } from '../capture/reconciler';
import { RenameCorrelator } from '../capture/renameCorrelator';
import type { HealthMonitor } from '../health/healthMonitor';
import type { Logger } from '../logging/logger';
import type { Store } from '../storage/store';
import { createIgnoreMatcher, type IgnoreMatcher } from './ignore';
import {
  canonicalizeRoot,
  toDisplayPath,
  toNormalizedPath
} from './paths';
import { WatcherService } from '../watcher/watcherService';
import { VaultTimers } from './vaultTimers';

export interface EventSink {
  emit<E extends EventName>(event: E, payload: EventMap[E]): void;
}

export interface VaultCoordinatorOptions {
  store: Store;
  logger: Logger;
  health: HealthMonitor;
  events: EventSink;
  /** Application-data directory, excluded from watching and scanning (§20). */
  dataDir: string;
}

const RECONCILE_LABEL = 'Changed while Recover.MD was closed';

export class VaultCoordinator {
  private vault: VaultRecord | null = null;
  private state: TrackingState = 'stopped';
  private capture: CaptureService | null = null;
  private watcher: WatcherService | null = null;
  private queue: CaptureQueue | null = null;
  private correlator = new RenameCorrelator();
  private ignoreMatcher: IgnoreMatcher;
  private indexProgress: IndexProgress | null = null;
  private readonly timers = new VaultTimers();
  private capturesBlocked = false;
  private stopping = false;
  private reconciling = false;

  constructor(private readonly options: VaultCoordinatorOptions) {
    this.ignoreMatcher = createIgnoreMatcher(options.store.settings.get().ignorePatterns);
  }

  // ---------------------------------------------------------------- status

  get currentVault(): VaultRecord | null {
    return this.vault;
  }

  get trackingState(): TrackingState {
    return this.state;
  }

  status(): VaultStatus {
    return {
      vault: this.vault,
      trackingState: this.state,
      indexProgress: this.indexProgress,
      safeMode: this.options.store.safeMode,
      pendingCaptures: this.queue?.pendingCount ?? 0,
      activeFileCount: this.vault ? this.options.store.files.activeCount(this.vault.id) : 0
    };
  }

  private setState(state: TrackingState): void {
    if (this.state === state) return;
    this.state = state;
    if (this.vault && !this.options.store.safeMode) {
      this.options.store.vaults.setTrackingState(this.vault.id, state);
    }
    this.options.events.emit('trackingStateChanged', { state });

    if (state === 'paused') {
      this.options.health.raise('tracking_paused', 'warning', 'Watching is paused. Changes are not being recorded.');
    } else {
      this.options.health.clear('tracking_paused');
    }
    if (state === 'stopped') {
      this.options.health.raise('tracking_stopped', 'error', 'Recover.MD is not protecting this folder. Changes are not being recorded.');
    } else {
      this.options.health.clear('tracking_stopped');
    }
    if (state === 'unavailable') {
      this.options.health.raise('vault_unavailable', 'error', 'The vault folder is not available.');
    } else {
      this.options.health.clear('vault_unavailable');
    }
  }

  // ---------------------------------------------------------------- lifecycle

  /** Selects (or re-selects) a vault root and begins tracking it. */
  async openVault(rootPath: string): Promise<VaultStatus> {
    await this.stopTracking();

    const canonical = await canonicalizeRoot(rootPath);
    const accessible = await fs
      .stat(canonical)
      .then((stat) => stat.isDirectory())
      .catch(() => false);

    if (this.options.store.safeMode) {
      this.options.health.raise(
        'database_safe_mode',
        'error',
        'The history database is open in read-only safe mode; new versions cannot be recorded.'
      );
    }

    const vault = this.options.store.vaults.upsert(rootPath, canonical);
    this.options.store.settings.setActiveVaultId(vault.id);
    this.vault = vault;

    if (!accessible) {
      this.setState('unavailable');
      return this.status();
    }

    await this.startTracking();
    return this.status();
  }

  /** Resumes the most recently used vault at launch (FR-1). */
  async resumeLastVault(): Promise<VaultStatus> {
    const vaultId = this.options.store.settings.getActiveVaultId();
    const vault = vaultId
      ? this.options.store.vaults.byId(vaultId)
      : this.options.store.vaults.mostRecent();
    if (!vault) {
      this.setState('stopped');
      return this.status();
    }
    return this.openVault(vault.rootPath);
  }

  /**
   * Starts watching and indexing. The watcher starts *before* the scan and buffers events
   * so nothing that happens during indexing is lost.
   */
  async startTracking(): Promise<VaultStatus> {
    const vault = this.vault;
    if (!vault) return this.status();
    if (this.options.store.safeMode) {
      this.setState('degraded');
      return this.status();
    }

    this.stopping = false;
    this.refreshIgnorePatterns();
    this.setState('starting');

    const settings = this.options.store.settings.get();

    // A deletion must stay claimable at least until a file appearing elsewhere could have
    // been captured: that is the debounce plus the delete grace, plus the correlation window.
    this.correlator = new RenameCorrelator({
      windowMs: settings.snapshotDelayMs + DELETE_GRACE_MS + RENAME_CORRELATION_WINDOW_MS
    });

    this.capture = new CaptureService({
      store: this.options.store,
      vaultId: vault.id,
      root: vault.canonicalRootPath,
      ignore: () => this.ignoreMatcher,
      logger: this.options.logger.child('capture'),
      emitter: {
        versionCaptured: (payload) => this.options.events.emit('versionCaptured', payload),
        fileStateChanged: (payload) => this.options.events.emit('fileStateChanged', payload),
        skippedFile: (report) =>
          this.options.health.raise(
            report.reason === 'too_large' ? 'file_too_large' : 'file_unreadable',
            'warning',
            report.reason === 'too_large'
              ? 'Some files are too large to be tracked.'
              : 'Some files could not be read.',
            { detail: report.detail, paths: [report.path] }
          )
      }
    });

    this.queue = new CaptureQueue({
      debounceMs: () => this.options.store.settings.get().snapshotDelayMs,
      maxIntervalMs: MAX_CONTINUOUS_EDIT_INTERVAL_MS,
      deleteGraceMs: DELETE_GRACE_MS,
      concurrency: CAPTURE_CONCURRENCY,
      execute: (task) => this.executeTask(task),
      onError: (task, error) => {
        this.options.logger.error('Capture task failed', {
          path: task.normalizedPath,
          error: error instanceof Error ? error.message : String(error)
        });
        this.options.health.raise('capture_failed', 'warning', 'A change could not be recorded.', {
          detail: error instanceof Error ? error.message : String(error),
          paths: [task.normalizedPath]
        });
      },
      onPendingChanged: (pending) =>
        this.options.events.emit('capturePending', { path: '', pending })
    });

    this.watcher = new WatcherService({
      root: vault.canonicalRootPath,
      ignore: () => this.ignoreMatcher,
      logger: this.options.logger.child('watcher'),
      excludedAbsolutePaths: [this.options.dataDir],
      onEvent: (event) => {
        if (this.state === 'paused' || this.stopping) return;
        const normalized = toNormalizedPath(vault.canonicalRootPath, event.absolutePath);
        if (event.kind === 'upsert') {
          this.queue?.touch(event.absolutePath, normalized);
        } else {
          // Register the pending deletion immediately, not when the grace period expires:
          // the file's new location may be captured before then, and it can only claim a
          // deletion that is already being held (FR-3 rename correlation).
          this.registerPendingDeletion(normalized);
          this.queue?.markDeleted(event.absolutePath, normalized);
        }
      },
      onReady: () => {
        if (this.state === 'starting') this.setState('indexing');
      },
      onDegraded: (error, attempt) => {
        this.setState('degraded');
        this.options.health.raise('watcher_restarting', 'warning', 'The file watcher is restarting.', {
          detail: `${error.message} (attempt ${attempt})`
        });
      },
      onRecovered: () => {
        this.options.health.clear('watcher_restarting');
        if (this.state === 'degraded') {
          this.setState('active');
          void this.reconcile('startup_reconciliation');
        }
      }
    });

    await this.watcher.start();
    this.setState('indexing');

    // Index in the background: the app must be usable while this runs (§11.1).
    void this.runInitialIndex().then(() => {
      this.watcher?.releaseBuffer();
      if (!this.stopping && this.state !== 'paused') this.setState('active');
    });

    this.startTimers(settings.snapshotDelayMs);
    return this.status();
  }

  private startTimers(_snapshotDelayMs: number): void {
    this.timers.start(PERIODIC_RECONCILE_INTERVAL_MS, 24 * 60 * 60 * 1000, {
      onPeriodic: () => {
        void this.reconcile('periodic_reconciliation');
        void this.checkDiskSpace();
      },
      onBackup: () => {
        void this.options.store.backup('daily').catch((error) => {
          this.options.logger.warn('Automatic backup failed', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    });
  }

  private stopTimers(): void {
    this.timers.stop();
  }

  async pauseTracking(): Promise<VaultStatus> {
    if (!this.vault) return this.status();
    await this.queue?.flush().catch(() => undefined);
    await this.correlator.flush().catch(() => undefined);
    this.setState('paused');
    return this.status();
  }

  async resumeTracking(): Promise<VaultStatus> {
    if (!this.vault) return this.status();
    if (this.state !== 'paused') return this.status();
    this.setState('indexing');
    await this.reconcile('startup_reconciliation');
    this.setState('active');
    return this.status();
  }

  /**
   * Full stop: flushes pending work, then tears the watcher down (FR-10 "Quit").
   * The selected vault is remembered so the UI can still show what is *not* being tracked.
   */
  async stopTracking(): Promise<void> {
    this.stopping = true;
    this.stopTimers();
    try {
      await this.queue?.flush();
      await this.correlator.flush();
    } catch (error) {
      this.options.logger.warn('Error while flushing pending captures', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    await this.watcher?.stop();
    this.watcher = null;
    this.queue = null;
    this.capture = null;
    this.correlator = new RenameCorrelator();
    this.setState('stopped');
  }

  /** Manual rescan from settings (FR-11). */
  async rescan(): Promise<VaultStatus> {
    await this.reconcile('startup_reconciliation');
    return this.status();
  }

  // ---------------------------------------------------------------- work

  private refreshIgnorePatterns(): void {
    this.ignoreMatcher = createIgnoreMatcher(this.options.store.settings.get().ignorePatterns);
  }

  /** Called when settings change so new ignore patterns take effect immediately. */
  onSettingsChanged(): void {
    this.refreshIgnorePatterns();
  }

  private async runInitialIndex(): Promise<void> {
    const vault = this.vault;
    const capture = this.capture;
    if (!vault || !capture) return;

    this.indexProgress = { phase: 'scanning', processed: 0, total: 0, currentPath: null };
    this.options.events.emit('indexProgress', this.indexProgress);

    const alreadyIndexed = this.options.store.files.count(vault.id) > 0;
    const report = await reconcileVault({
      store: this.options.store,
      vaultId: vault.id,
      root: vault.canonicalRootPath,
      ignore: this.ignoreMatcher,
      capture,
      // A first-ever scan produces baselines; a later start is reconciliation (AC-1/AC-16).
      origin: alreadyIndexed ? 'startup_reconciliation' : 'initial_scan',
      label: alreadyIndexed ? RECONCILE_LABEL : null,
      excludedAbsolutePaths: [this.options.dataDir],
      shouldStop: () => this.stopping,
      onProgress: (progress) => {
        this.indexProgress = {
          phase: 'capturing',
          processed: progress.processed,
          total: progress.total,
          currentPath: progress.currentPath
        };
        this.options.events.emit('indexProgress', this.indexProgress);
      }
    });

    this.options.store.vaults.markScanned(vault.id);
    this.options.logger.info('Initial index complete', { ...report });

    this.indexProgress = {
      phase: 'done',
      processed: report.scanned,
      total: report.scanned,
      currentPath: null
    };
    this.options.events.emit('indexProgress', this.indexProgress);
  }

  /** Lightweight reconciliation (FR-3). Never runs twice concurrently. */
  async reconcile(origin: 'startup_reconciliation' | 'periodic_reconciliation'): Promise<void> {
    const vault = this.vault;
    const capture = this.capture;
    if (!vault || !capture || this.reconciling || this.stopping) return;
    if (this.state === 'paused') return;

    this.reconciling = true;
    try {
      const accessible = await fs
        .stat(vault.canonicalRootPath)
        .then((stat) => stat.isDirectory())
        .catch(() => false);
      if (!accessible) {
        this.setState('unavailable');
        return;
      }
      if (this.state === 'unavailable') {
        this.setState('active');
      }

      await reconcileVault({
        store: this.options.store,
        vaultId: vault.id,
        root: vault.canonicalRootPath,
        ignore: this.ignoreMatcher,
        capture,
        origin,
        label: origin === 'startup_reconciliation' ? RECONCILE_LABEL : null,
        excludedAbsolutePaths: [this.options.dataDir],
        shouldStop: () => this.stopping
      });
    } catch (error) {
      this.options.logger.warn('Reconciliation failed', {
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.reconciling = false;
    }
  }

  /** Called after the system wakes (§19.6). */
  async handleSystemWake(): Promise<void> {
    this.options.logger.info('System wake detected; verifying watcher and reconciling');
    await this.watcher?.forceRestart();
    await this.reconcile('startup_reconciliation');
  }

  private async executeTask(task: QueuedTask): Promise<void> {
    const capture = this.capture;
    const vault = this.vault;
    if (!capture || !vault) return;
    if (this.capturesBlocked) {
      this.options.logger.warn('Capture skipped: storage unavailable', { path: task.normalizedPath });
      return;
    }

    if (task.kind === 'capture') {
      const result = await capture.captureFromDisk(task.absolutePath, 'watcher', {
        claimRename: (candidate) => {
          const claim = this.correlator.claim(candidate);
          if (!claim) return null;
          this.options.logger.info('Rename detected', {
            from: claim.deletion.displayPath,
            confidence: claim.confidence
          });
          return { fileId: claim.deletion.fileId, fromDisplayPath: claim.deletion.displayPath };
        }
      });
      if (result.status === 'missing') {
        // It disappeared between the event and the read: treat it as a deletion candidate.
        this.queue?.markDeleted(task.absolutePath, task.normalizedPath);
      }
      return;
    }

    await this.handleDeletion(task);
  }

  /**
   * Starts holding a deletion so a file that reappears elsewhere can claim it as a rename.
   * Holding it does not commit anything: {@link handleDeletion} decides the outcome once
   * the grace period has passed.
   */
  private registerPendingDeletion(normalizedPath: string): void {
    const vault = this.vault;
    if (!vault) return;
    if (this.correlator.has(normalizedPath)) return;

    const file = this.options.store.files.activeByNormalizedPath(vault.id, normalizedPath);
    if (!file) return;

    const lastContent = this.options.store.versions.latestContent(file.id);
    this.correlator.register(
      {
        fileId: file.id,
        normalizedPath: file.normalizedPath,
        displayPath: file.currentPath,
        contentHash: lastContent?.blobHash ?? null,
        byteSize: lastContent?.byteSize ?? 0,
        ino: readNumber(lastContent?.metadata.ino),
        dev: readNumber(lastContent?.metadata.dev),
        registeredAt: Date.now()
      },
      // Expiry commits nothing: an unclaimed deletion becomes a tombstone through the
      // capture queue, which is also what guarantees ordering against other work.
      async () => undefined
    );
  }

  /**
   * Decides what a disappearance actually meant (FR-3, AC-6/AC-7):
   *   - the file moved and its new location already claimed it → nothing to do
   *   - the file is back at the same path (atomic save) → capture it as a modification
   *   - the file is really gone → write the tombstone
   */
  private async handleDeletion(task: QueuedTask): Promise<void> {
    const vault = this.vault;
    const capture = this.capture;
    if (!vault || !capture) return;

    const file = this.options.store.files.activeByNormalizedPath(vault.id, task.normalizedPath);
    if (!file) {
      // Already claimed as a rename, or never tracked.
      this.correlator.release(task.normalizedPath);
      return;
    }

    const exists = await fs
      .access(task.absolutePath)
      .then(() => true)
      .catch(() => false);

    this.correlator.release(task.normalizedPath);

    if (exists) {
      this.queue?.touch(task.absolutePath, task.normalizedPath);
      return;
    }
    capture.recordDeletion(task.normalizedPath, 'watcher');
  }

  private async checkDiskSpace(): Promise<void> {
    const free = await this.options.health.checkDiskSpace(this.options.dataDir);
    if (free === null) return;
    const wasBlocked = this.capturesBlocked;
    this.capturesBlocked = this.options.health.has('disk_space_low');
    if (wasBlocked && !this.capturesBlocked) {
      this.options.logger.info('Disk space recovered; resuming captures');
      void this.reconcile('periodic_reconciliation');
    }
  }

  /**
   * Handle used by the restore service: the live capture service plus the vault root.
   * Null when no vault is being tracked, which is exactly when restore must refuse to run.
   */
  captureContext(): {
    root: string;
    vaultId: string;
    capture: CaptureService;
    suppressWatcher: (normalizedPath: string) => void;
  } | null {
    if (!this.vault || !this.capture) return null;
    return {
      root: this.vault.canonicalRootPath,
      vaultId: this.vault.id,
      capture: this.capture,
      suppressWatcher: (normalizedPath) => this.ignoreNextChange(normalizedPath)
    };
  }

  /** Absolute path for a vault-relative display path. */
  absolutePathFor(displayPath: string): string | null {
    if (!this.vault) return null;
    return path.join(this.vault.canonicalRootPath, ...displayPath.split('/'));
  }

  /** Vault-relative display path for an absolute path. */
  displayPathFor(absolutePath: string): string | null {
    if (!this.vault) return null;
    return toDisplayPath(this.vault.canonicalRootPath, absolutePath);
  }

  /**
   * Suppresses watcher-driven capture for a path Recover.MD is about to write itself, so a
   * restore does not immediately produce a second, duplicate version (§15 restore flow).
   */
  ignoreNextChange(normalizedPath: string): void {
    this.queue?.cancel(normalizedPath);
  }

  async flushPending(): Promise<void> {
    await this.queue?.flush();
    await this.correlator.flush();
  }
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
