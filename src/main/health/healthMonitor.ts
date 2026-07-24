/**
 * Health and diagnostics (FR-12).
 *
 * Failures must be visible: every condition that stops Recover.MD from capturing changes
 * is surfaced as a persistent issue rather than logged and forgotten.
 */
import { statfs } from 'node:fs/promises';
import { LOW_DISK_SPACE_BYTES } from '@shared/constants';
import type { HealthIssue, HealthIssueCode, HealthStatus } from '@shared/types/domain';

export type HealthListener = (status: HealthStatus) => void;

export class HealthMonitor {
  private readonly issues = new Map<HealthIssueCode, HealthIssue>();
  private readonly listeners = new Set<HealthListener>();

  /** Raises or updates an issue. Re-raising keeps the original `since` timestamp. */
  raise(
    code: HealthIssueCode,
    severity: HealthIssue['severity'],
    message: string,
    extra: { detail?: string; paths?: string[] } = {}
  ): void {
    const existing = this.issues.get(code);
    const issue: HealthIssue = {
      code,
      severity,
      message,
      detail: extra.detail,
      paths: extra.paths,
      since: existing?.since ?? Date.now()
    };
    const unchanged =
      existing &&
      existing.severity === issue.severity &&
      existing.message === issue.message &&
      existing.detail === issue.detail;
    this.issues.set(code, issue);
    if (!unchanged) this.notify();
  }

  clear(code: HealthIssueCode): void {
    if (this.issues.delete(code)) this.notify();
  }

  has(code: HealthIssueCode): boolean {
    return this.issues.has(code);
  }

  status(): HealthStatus {
    const issues = [...this.issues.values()].sort((a, b) => a.since - b.since);
    return { issues, healthy: issues.every((issue) => issue.severity !== 'error') };
  }

  onChange(listener: HealthListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }

  /**
   * Checks free space where history is stored. Returns the free byte count so the caller
   * can decide whether to pause captures (§19.3).
   */
  async checkDiskSpace(directory: string, threshold = LOW_DISK_SPACE_BYTES): Promise<number | null> {
    try {
      const stats = await statfs(directory);
      const free = Number(stats.bavail) * Number(stats.bsize);
      if (free < threshold) {
        this.raise(
          'disk_space_low',
          'error',
          'Not enough free disk space to record new versions.',
          { detail: `${formatBytes(free)} free where Recover.MD stores history.` }
        );
      } else {
        this.clear('disk_space_low');
      }
      return free;
    } catch {
      // A platform without statfs support must not look like a disk-full condition.
      return null;
    }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}
