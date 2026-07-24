/**
 * Recursive filesystem watcher (FR-3).
 *
 * Thin wrapper over chokidar with three responsibilities the rest of the app relies on:
 *  - filtering to tracked Markdown files before events reach the capture queue
 *  - buffering events while the initial scan runs, then replaying them (Milestone 3)
 *  - restarting with bounded exponential backoff and reporting a degraded state (§19.2)
 */
import chokidar, { type FSWatcher } from 'chokidar';
import type { Logger } from '../logging/logger';
import type { IgnoreMatcher } from '../vault/ignore';
import { isMarkdownPath, toDisplayPath } from '../vault/paths';

export type WatcherEventKind = 'upsert' | 'unlink';

export interface WatcherEvent {
  kind: WatcherEventKind;
  absolutePath: string;
}

export interface WatcherServiceOptions {
  root: string;
  ignore: () => IgnoreMatcher;
  logger: Logger;
  onEvent: (event: WatcherEvent) => void;
  onReady: () => void;
  onDegraded: (error: Error, attempt: number) => void;
  onRecovered: () => void;
  /** Directories that must never be watched (the application-data directory). */
  excludedAbsolutePaths?: readonly string[];
  maxRestartDelayMs?: number;
}

export class WatcherService {
  private watcher: FSWatcher | null = null;
  private buffering = true;
  private readonly buffer: WatcherEvent[] = [];
  private restartAttempt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(private readonly options: WatcherServiceOptions) {}

  get isBuffering(): boolean {
    return this.buffering;
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  /**
   * Starts watching. Events are buffered until {@link releaseBuffer} is called so changes
   * made during the initial scan are never lost (AC: "changes made during initial scan").
   */
  async start(): Promise<void> {
    this.stopped = false;
    await this.spawn();
  }

  private async spawn(): Promise<void> {
    const excluded = new Set((this.options.excludedAbsolutePaths ?? []).map((p) => p.toLowerCase()));

    const watcher = chokidar.watch(this.options.root, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      // Recover.MD does its own coalescing and stable-state detection (FR-3), so chokidar
      // must report raw events rather than waiting itself.
      awaitWriteFinish: false,
      ignored: (target: string) => {
        if (excluded.has(target.toLowerCase())) return true;
        const relative = toDisplayPath(this.options.root, target);
        if (relative === '' || relative.startsWith('..')) return false;
        const matcher = this.options.ignore();
        if (matcher.ignoresDirectory(relative)) return true;
        return false;
      }
    });

    watcher.on('add', (target) => this.emit('upsert', target));
    watcher.on('change', (target) => this.emit('upsert', target));
    watcher.on('unlink', (target) => this.emit('unlink', target));
    watcher.on('ready', () => {
      this.restartAttempt = 0;
      this.options.onRecovered();
      this.options.onReady();
    });
    watcher.on('error', (error) => {
      this.options.logger.error('Watcher error', {
        error: error instanceof Error ? error.message : String(error)
      });
      void this.restart(error instanceof Error ? error : new Error(String(error)));
    });

    this.watcher = watcher;
  }

  private emit(kind: WatcherEventKind, absolutePath: string): void {
    if (!isMarkdownPath(absolutePath)) return;
    const relative = toDisplayPath(this.options.root, absolutePath);
    if (relative.startsWith('..')) return;
    if (this.options.ignore().ignoresFile(relative)) return;

    const event: WatcherEvent = { kind, absolutePath };
    if (this.buffering) {
      this.buffer.push(event);
      return;
    }
    this.options.onEvent(event);
  }

  /** Replays buffered events and switches to live delivery. */
  releaseBuffer(): void {
    this.buffering = false;
    const queued = this.buffer.splice(0, this.buffer.length);
    for (const event of queued) this.options.onEvent(event);
  }

  private async restart(error: Error): Promise<void> {
    if (this.stopped) return;
    this.restartAttempt += 1;
    this.options.onDegraded(error, this.restartAttempt);

    await this.closeWatcher();

    const maxDelay = this.options.maxRestartDelayMs ?? 30_000;
    const delay = Math.min(maxDelay, 500 * 2 ** (this.restartAttempt - 1));
    this.options.logger.warn('Restarting watcher', { attempt: this.restartAttempt, delay });

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.spawn();
    }, delay);
    this.restartTimer.unref?.();
  }

  /** Forces a restart from outside, e.g. after the system wakes from sleep (§19.6). */
  async forceRestart(): Promise<void> {
    if (this.stopped) return;
    await this.closeWatcher();
    await this.spawn();
  }

  private async closeWatcher(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) await watcher.close().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.buffering = true;
    this.buffer.length = 0;
    await this.closeWatcher();
  }
}
