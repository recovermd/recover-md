/**
 * Event coalescing and stable-state detection (FR-3).
 *
 * Filesystem events do not map to versions. This queue turns a storm of events into one
 * capture per file per stable state:
 *
 *  - a write schedules a capture `debounceMs` in the future; another write resets it
 *  - a file edited continuously is still captured every `maxIntervalMs`
 *  - a delete waits `deleteGraceMs`, so the temp-file dance of an atomic save reads as a
 *    modification rather than a delete followed by an unrelated create
 *  - work for one file never runs concurrently with itself; work across files is bounded
 */

export type QueuedKind = 'capture' | 'delete';

export interface QueuedTask {
  kind: QueuedKind;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Identity key; see `vault/paths`. */
  normalizedPath: string;
  /** When the first event of this pending batch was observed. */
  firstEventAt: number;
}

export interface CaptureQueueOptions {
  /** Read on each schedule so a settings change takes effect immediately (FR-11). */
  debounceMs: () => number;
  maxIntervalMs: number;
  deleteGraceMs: number;
  concurrency: number;
  execute: (task: QueuedTask) => Promise<void>;
  onError?: (task: QueuedTask, error: unknown) => void;
  onPendingChanged?: (pending: number) => void;
  now?: () => number;
}

interface PendingEntry {
  kind: QueuedKind;
  absolutePath: string;
  normalizedPath: string;
  firstEventAt: number;
  timer: NodeJS.Timeout;
  dueAt: number;
}

export class CaptureQueue {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly running = new Set<string>();
  private readonly ready: QueuedTask[] = [];
  /** Keys that received an event while their capture was running. */
  private readonly requeue = new Map<string, QueuedTask>();
  private active = 0;
  private draining = false;

  constructor(private readonly options: CaptureQueueOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Number of files with an unrecorded change. Drives the "Recording change…" state. */
  get pendingCount(): number {
    return this.pending.size + this.ready.length + this.running.size;
  }

  /** A create or modify event was observed. */
  touch(absolutePath: string, normalizedPath: string): void {
    this.schedule('capture', absolutePath, normalizedPath, this.options.debounceMs());
  }

  /** An unlink event was observed; committing it is deferred by the grace period. */
  markDeleted(absolutePath: string, normalizedPath: string): void {
    this.schedule('delete', absolutePath, normalizedPath, this.options.deleteGraceMs);
  }

  private schedule(
    kind: QueuedKind,
    absolutePath: string,
    normalizedPath: string,
    delayMs: number
  ): void {
    const now = this.now();
    const existing = this.pending.get(normalizedPath);

    // A write that arrives while a delete is pending means the file was replaced, not
    // removed (FR-3 atomic saves). The delete is dropped.
    const firstEventAt = existing?.kind === kind ? existing.firstEventAt : now;

    if (existing) clearTimeout(existing.timer);

    // Continuous editing must not postpone capture forever (FR-3 / AC-4).
    const elapsed = now - firstEventAt;
    const remainingBudget = Math.max(0, this.options.maxIntervalMs - elapsed);
    const effectiveDelay = kind === 'capture' ? Math.min(delayMs, remainingBudget) : delayMs;

    const timer = setTimeout(() => this.promote(normalizedPath), effectiveDelay);
    // Do not hold the process open purely for a pending capture.
    timer.unref?.();

    this.pending.set(normalizedPath, {
      kind,
      absolutePath,
      normalizedPath,
      firstEventAt,
      timer,
      dueAt: now + effectiveDelay
    });
    this.options.onPendingChanged?.(this.pendingCount);
  }

  private promote(normalizedPath: string): void {
    const entry = this.pending.get(normalizedPath);
    if (!entry) return;
    this.pending.delete(normalizedPath);
    clearTimeout(entry.timer);

    const task: QueuedTask = {
      kind: entry.kind,
      absolutePath: entry.absolutePath,
      normalizedPath: entry.normalizedPath,
      firstEventAt: entry.firstEventAt
    };

    if (this.running.has(normalizedPath)) {
      // Preserve per-file ordering: run it after the in-flight task finishes (FR-3).
      this.requeue.set(normalizedPath, task);
      return;
    }
    this.ready.push(task);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.ready.length > 0 && this.active < this.options.concurrency) {
        const task = this.ready.shift();
        if (!task) break;
        if (this.running.has(task.normalizedPath)) {
          this.requeue.set(task.normalizedPath, task);
          continue;
        }
        this.active += 1;
        this.running.add(task.normalizedPath);
        void this.run(task);
      }
    } finally {
      this.draining = false;
    }
  }

  private async run(task: QueuedTask): Promise<void> {
    try {
      await this.options.execute(task);
    } catch (error) {
      this.options.onError?.(task, error);
    } finally {
      this.active -= 1;
      this.running.delete(task.normalizedPath);
      const queued = this.requeue.get(task.normalizedPath);
      if (queued) {
        this.requeue.delete(task.normalizedPath);
        this.ready.push(queued);
      }
      this.options.onPendingChanged?.(this.pendingCount);
      void this.drain();
    }
  }

  /** Cancels a pending entry, e.g. when a delete turns out to be a rename. */
  cancel(normalizedPath: string): boolean {
    const entry = this.pending.get(normalizedPath);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(normalizedPath);
    this.options.onPendingChanged?.(this.pendingCount);
    return true;
  }

  hasPending(normalizedPath: string): boolean {
    return this.pending.has(normalizedPath);
  }

  /** Runs every pending task now and waits for the queue to empty (shutdown flush, FR-3). */
  async flush(): Promise<void> {
    for (const key of [...this.pending.keys()]) {
      this.promote(key);
    }
    await this.idle();
  }

  /** Resolves once nothing is pending, ready or running. */
  async idle(): Promise<void> {
    for (;;) {
      if (this.pendingCount === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Drops everything without executing it (used when tracking is paused or stopped). */
  clear(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    this.ready.length = 0;
    this.requeue.clear();
    this.options.onPendingChanged?.(this.pendingCount);
  }
}
