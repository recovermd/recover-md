/**
 * Recursive vault scanner (FR-2, Milestone 3).
 *
 * Read-only by contract: scanning never writes to the workspace. Symlinked directories are
 * not followed, which prevents both loops and accidental tracking outside the vault.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_FILE_BYTES } from '@shared/constants';
import type { SkippedFileReport } from '@shared/types/domain';
import type { IgnoreMatcher } from './ignore';
import { isMarkdownPath, toDisplayPath, toNormalizedPath } from './paths';

export interface ScannedFile {
  absolutePath: string;
  displayPath: string;
  normalizedPath: string;
  byteSize: number;
  mtimeMs: number;
}

export interface ScanOptions {
  root: string;
  ignore: IgnoreMatcher;
  /** Directories that must never be descended into (e.g. the app-data directory). */
  excludedAbsolutePaths?: readonly string[];
  maxFileBytes?: number;
  onSkipped?: (report: SkippedFileReport) => void;
}

/**
 * Walks the vault breadth-first, yielding supported Markdown files. Unreadable directories
 * are reported and skipped rather than aborting the scan.
 */
export async function* scanVault(options: ScanOptions): AsyncGenerator<ScannedFile> {
  const { root, ignore } = options;
  const maxBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const excluded = new Set((options.excludedAbsolutePaths ?? []).map((p) => path.resolve(p)));

  const queue: string[] = [root];

  while (queue.length > 0) {
    const directory = queue.shift();
    if (directory === undefined) break;
    if (excluded.has(path.resolve(directory))) continue;

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      options.onSkipped?.({
        path: toDisplayPath(root, directory),
        reason: 'unreadable',
        detail: describeError(error),
        byteSize: null,
        at: Date.now()
      });
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const displayPath = toDisplayPath(root, absolutePath);

      if (entry.isSymbolicLink()) {
        // FR-2: symlinks are not followed. A symlinked *file* is also skipped so we never
        // capture content that lives outside the vault.
        continue;
      }

      if (entry.isDirectory()) {
        if (ignore.ignoresDirectory(displayPath)) continue;
        if (excluded.has(path.resolve(absolutePath))) continue;
        queue.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!isMarkdownPath(absolutePath)) continue;
      if (ignore.ignoresFile(displayPath)) continue;

      let stat;
      try {
        stat = await fs.stat(absolutePath);
      } catch (error) {
        options.onSkipped?.({
          path: displayPath,
          reason: 'unreadable',
          detail: describeError(error),
          byteSize: null,
          at: Date.now()
        });
        continue;
      }

      if (stat.size > maxBytes) {
        options.onSkipped?.({
          path: displayPath,
          reason: 'too_large',
          detail: `File is ${stat.size} bytes; the limit is ${maxBytes} bytes.`,
          byteSize: stat.size,
          at: Date.now()
        });
        continue;
      }

      yield {
        absolutePath,
        displayPath,
        normalizedPath: toNormalizedPath(root, absolutePath),
        byteSize: stat.size,
        mtimeMs: stat.mtimeMs
      };
    }
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
