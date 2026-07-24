/**
 * Client for the diff worker thread.
 *
 * If the worker cannot be started (packaging quirk, resource exhaustion) the client falls
 * back to computing the diff in-process. A slower diff is acceptable; a broken diff view
 * is not.
 */
import { Worker } from 'node:worker_threads';
import type { DiffResult } from '@shared/types/domain';
import { computeLineDiff } from './diffEngine';
import type { Logger } from '../logging/logger';
import type { DiffJobResponse } from '../../workers/diff/cpuWorker';

interface PendingJob {
  resolve: (result: DiffResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DiffWorkerOptions {
  workerPath: string | null;
  logger: Logger;
  timeoutMs?: number;
}

export class DiffWorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingJob>();
  private disabled = false;
  private disposed = false;

  constructor(private readonly options: DiffWorkerOptions) {
    this.disabled = options.workerPath === null;
  }

  private ensureWorker(): Worker | null {
    if (this.disabled || this.disposed) return null;
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(this.options.workerPath!);
      worker.on('message', (message: DiffJobResponse) => this.settle(message));
      worker.on('error', (error) => this.failAll(error));
      worker.on('exit', (code) => {
        this.worker = null;
        if (code !== 0) this.failAll(new Error(`Diff worker exited with code ${code}`));
      });
      worker.unref();
      this.worker = worker;
      return worker;
    } catch (error) {
      this.options.logger.warn('Diff worker unavailable, falling back to in-process diff', {
        error: error instanceof Error ? error.message : String(error)
      });
      this.disabled = true;
      return null;
    }
  }

  private settle(message: DiffJobResponse): void {
    const job = this.pending.get(message.id);
    if (!job) return;
    this.pending.delete(message.id);
    clearTimeout(job.timer);
    if (message.ok) job.resolve(message.result);
    else job.reject(new Error(message.error));
  }

  private failAll(error: Error): void {
    this.options.logger.warn('Diff worker failed', { error: error.message });
    for (const [id, job] of this.pending) {
      clearTimeout(job.timer);
      job.reject(error);
      this.pending.delete(id);
    }
    this.worker = null;
  }

  /** Computes a diff, transparently falling back to the main thread on any worker problem. */
  async diff(oldText: string | null, newText: string | null): Promise<DiffResult> {
    const worker = this.ensureWorker();
    if (!worker) return computeLineDiff(oldText, newText);

    const id = this.nextId++;
    try {
      return await new Promise<DiffResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('Diff worker timed out'));
        }, this.options.timeoutMs ?? 15_000);
        this.pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, oldText, newText });
      });
    } catch (error) {
      this.options.logger.warn('Diff worker job failed; computing in-process', {
        error: error instanceof Error ? error.message : String(error)
      });
      return computeLineDiff(oldText, newText);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}
