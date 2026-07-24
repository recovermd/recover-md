/**
 * Ignore rules (FR-2).
 *
 * Deliberately *not* a full gitignore implementation: patterns are simple globs matched
 * against vault-relative POSIX paths. Hidden directories are not excluded wholesale
 * because vaults legitimately keep notes in them.
 */
import { DEFAULT_IGNORE_PATTERNS } from '@shared/constants';
import { isCaseInsensitivePlatform } from './paths';

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === '*') {
      const isDouble = pattern[i + 1] === '*';
      if (isDouble) {
        const followedBySlash = pattern[i + 2] === '/';
        if (followedBySlash) {
          // `**/` matches zero or more leading directories.
          source += '(?:[^/]+/)*';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export interface IgnoreMatcher {
  /** True when a file at this vault-relative path must not be tracked. */
  ignoresFile(relativePath: string): boolean;
  /** True when a directory (and everything under it) must be skipped. */
  ignoresDirectory(relativePath: string): boolean;
  readonly patterns: readonly string[];
}

/**
 * Builds a matcher from the default exclusions plus user patterns (FR-11).
 * `extraAbsoluteExclusions` covers the application-data directory when it happens to sit
 * inside the vault — Recover.MD must never track its own storage.
 */
export function createIgnoreMatcher(
  userPatterns: readonly string[] = [],
  platform: NodeJS.Platform = process.platform
): IgnoreMatcher {
  const caseInsensitive = isCaseInsensitivePlatform(platform);
  const patterns = [...DEFAULT_IGNORE_PATTERNS, ...userPatterns]
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);

  const normalized = patterns.map((pattern) =>
    caseInsensitive ? pattern.toLowerCase() : pattern
  );

  const fileRegexes = normalized.map(globToRegExp);
  // A pattern like `.git/**` should also prune the `.git` directory itself.
  const directoryRegexes = normalized.map((pattern) =>
    globToRegExp(pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern)
  );

  const prepare = (value: string): string => {
    const unified = value.split('\\').join('/').replace(/^\.\//, '').replace(/\/+$/, '');
    return caseInsensitive ? unified.toLowerCase() : unified;
  };

  return {
    patterns,
    ignoresFile(relativePath: string): boolean {
      const value = prepare(relativePath);
      if (value === '') return false;
      return fileRegexes.some((regex) => regex.test(value));
    },
    ignoresDirectory(relativePath: string): boolean {
      const value = prepare(relativePath);
      if (value === '') return false;
      return (
        directoryRegexes.some((regex) => regex.test(value)) ||
        fileRegexes.some((regex) => regex.test(value))
      );
    }
  };
}
