import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureQueue, type QueuedTask } from '../../src/main/capture/captureQueue';

function createQueue(overrides: Partial<Parameters<typeof makeOptions>[0]> = {}) {
  const executed: QueuedTask[] = [];
  const options = makeOptions({ executed, ...overrides });
  return { queue: new CaptureQueue(options), executed };
}

function makeOptions(config: {
  executed: QueuedTask[];
  debounceMs?: number;
  maxIntervalMs?: number;
  deleteGraceMs?: number;
  execute?: (task: QueuedTask) => Promise<void>;
}) {
  return {
    debounceMs: () => config.debounceMs ?? 2000,
    maxIntervalMs: config.maxIntervalMs ?? 60_000,
    deleteGraceMs: config.deleteGraceMs ?? 2000,
    concurrency: 4,
    execute:
      config.execute ??
      (async (task: QueuedTask) => {
        config.executed.push(task);
      })
  };
}

describe('CaptureQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid writes into a single capture (AC-3)', async () => {
    const { queue, executed } = createQueue();
    for (let i = 0; i < 10; i += 1) {
      queue.touch('/vault/a.md', 'a.md');
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.kind).toBe('capture');
  });

  it('captures at the maximum interval during continuous editing (AC-4)', async () => {
    const { queue, executed } = createQueue({ maxIntervalMs: 5000, debounceMs: 2000 });
    for (let i = 0; i < 20; i += 1) {
      queue.touch('/vault/a.md', 'a.md');
      await vi.advanceTimersByTimeAsync(1000);
    }
    // Without the maximum interval the debounce would keep resetting forever.
    expect(executed.length).toBeGreaterThanOrEqual(3);
  });

  it('drops a pending delete when the file reappears — an atomic save (AC-6)', async () => {
    const { queue, executed } = createQueue();
    queue.markDeleted('/vault/a.md', 'a.md');
    await vi.advanceTimersByTimeAsync(500);
    queue.touch('/vault/a.md', 'a.md');
    await vi.advanceTimersByTimeAsync(5000);

    expect(executed).toHaveLength(1);
    expect(executed[0]?.kind).toBe('capture');
  });

  it('commits a delete when nothing replaces the file', async () => {
    const { queue, executed } = createQueue();
    queue.markDeleted('/vault/a.md', 'a.md');
    await vi.advanceTimersByTimeAsync(2500);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.kind).toBe('delete');
  });

  it('never runs two tasks for the same file concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const { queue } = createQueue({
      execute: async (task) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(task.normalizedPath);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active -= 1;
      }
    });

    queue.touch('/vault/a.md', 'a.md');
    await vi.advanceTimersByTimeAsync(2000);
    queue.touch('/vault/a.md', 'a.md');
    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(200);

    expect(maxActive).toBe(1);
    expect(order).toEqual(['a.md', 'a.md']);
  });

  it('runs different files concurrently within the bound', async () => {
    let active = 0;
    let maxActive = 0;
    const { queue } = createQueue({
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active -= 1;
      }
    });

    queue.touch('/vault/a.md', 'a.md');
    queue.touch('/vault/b.md', 'b.md');
    queue.touch('/vault/c.md', 'c.md');
    await vi.advanceTimersByTimeAsync(2000);
    expect(maxActive).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(200);
  });

  it('reports pending work and can be cancelled', async () => {
    const { queue, executed } = createQueue();
    queue.touch('/vault/a.md', 'a.md');
    expect(queue.pendingCount).toBe(1);
    expect(queue.cancel('a.md')).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(executed).toHaveLength(0);
  });

  it('flushes pending work immediately on shutdown', async () => {
    const { queue, executed } = createQueue();
    queue.touch('/vault/a.md', 'a.md');
    queue.touch('/vault/b.md', 'b.md');
    const flushed = queue.flush();
    await vi.advanceTimersByTimeAsync(100);
    await flushed;
    expect(executed).toHaveLength(2);
  });
});
