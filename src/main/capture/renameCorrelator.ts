/**
 * Rename correlation (FR-3, AC-7).
 *
 * A rename on disk is two events: a disappearance and an appearance. Recover.MD holds a
 * deletion for a short window before committing its tombstone, so a file that reappears
 * elsewhere with the same identity can claim it and keep one timeline.
 *
 * Confidence order, per the PRD:
 *   1. filesystem identity (inode/dev) when the platform reports it
 *   2. identical content hash *and* byte size within the correlation window
 *   3. otherwise: no claim — a delete plus a create, never a merged history
 */
import { RENAME_CORRELATION_WINDOW_MS } from '@shared/constants';

export interface PendingDeletion {
  fileId: string;
  normalizedPath: string;
  displayPath: string;
  /** Hash of the last known content, used as the fallback identity signal. */
  contentHash: string | null;
  byteSize: number;
  ino: number | null;
  dev: number | null;
  registeredAt: number;
}

export interface RenameCandidate {
  contentHash: string;
  byteSize: number;
  ino: number | null;
  dev: number | null;
}

export type RenameConfidence = 'filesystem_identity' | 'content_match';

export interface RenameClaim {
  deletion: PendingDeletion;
  confidence: RenameConfidence;
}

export interface RenameCorrelatorOptions {
  windowMs?: number;
  now?: () => number;
}

export class RenameCorrelator {
  private readonly entries = new Map<string, { deletion: PendingDeletion; commit: () => Promise<void>; timer: NodeJS.Timeout }>();
  private readonly windowMs: number;

  constructor(private readonly options: RenameCorrelatorOptions = {}) {
    this.windowMs = options.windowMs ?? RENAME_CORRELATION_WINDOW_MS;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Holds a deletion for the correlation window. `commit` writes the tombstone and is
   * called only if nothing claims the deletion as a rename.
   */
  register(deletion: PendingDeletion, commit: () => Promise<void>): void {
    const existing = this.entries.get(deletion.normalizedPath);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.entries.delete(deletion.normalizedPath);
      void commit();
    }, this.windowMs);
    timer.unref?.();

    this.entries.set(deletion.normalizedPath, { deletion, commit, timer });
  }

  /**
   * Attempts to claim a pending deletion for a file that just appeared. Returns null when
   * no candidate is confident enough — the safe interpretation (§8 conservative ambiguity).
   */
  claim(candidate: RenameCandidate): RenameClaim | null {
    const now = this.now();
    let contentMatch: { key: string; deletion: PendingDeletion } | null = null;

    for (const [key, entry] of this.entries) {
      const { deletion } = entry;
      if (now - deletion.registeredAt > this.windowMs) continue;

      const identityKnown =
        deletion.ino !== null && deletion.ino !== 0 && candidate.ino !== null && candidate.ino !== 0;
      if (identityKnown && deletion.ino === candidate.ino && deletion.dev === candidate.dev) {
        this.take(key);
        return { deletion, confidence: 'filesystem_identity' };
      }

      if (
        deletion.contentHash !== null &&
        deletion.contentHash === candidate.contentHash &&
        deletion.byteSize === candidate.byteSize &&
        contentMatch === null
      ) {
        contentMatch = { key, deletion };
      }
    }

    if (contentMatch) {
      // Ambiguity guard: if two pending deletions share the same content we cannot tell
      // which one moved, so we decline rather than risk merging unrelated histories.
      const duplicates = [...this.entries.values()].filter(
        (entry) =>
          entry.deletion.contentHash === candidate.contentHash &&
          entry.deletion.byteSize === candidate.byteSize
      );
      if (duplicates.length > 1) return null;

      this.take(contentMatch.key);
      return { deletion: contentMatch.deletion, confidence: 'content_match' };
    }

    return null;
  }

  private take(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(key);
  }

  /**
   * Drops a held deletion without committing it, used once its outcome has been decided
   * elsewhere (the tombstone was written, or the file came back at the same path).
   */
  release(normalizedPath: string): void {
    this.take(normalizedPath);
  }

  has(normalizedPath: string): boolean {
    return this.entries.has(normalizedPath);
  }

  /** Commits every held deletion immediately (shutdown, pause, reconciliation). */
  async flush(): Promise<void> {
    const held = [...this.entries.values()];
    this.entries.clear();
    for (const entry of held) {
      clearTimeout(entry.timer);
      await entry.commit();
    }
  }

  /** Drops held deletions without committing them (tracking stopped). */
  clear(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }
}
