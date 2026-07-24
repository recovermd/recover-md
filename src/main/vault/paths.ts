/**
 * Path normalization and vault containment (§20 "filesystem safety").
 *
 * Two distinct notions of "path" exist in Recover.MD:
 *  - **display path**: vault-relative, forward slashes, original case. Shown to users and
 *    stored on versions so a rename keeps its historical spelling.
 *  - **normalized path**: the identity key. Lower-cased on case-insensitive platforms so
 *    `Notes/A.md` and `notes/a.md` are the same file there, and not on Linux.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MARKDOWN_EXTENSION } from '@shared/constants';

/** macOS and Windows treat paths case-insensitively by default; Linux does not. */
export function isCaseInsensitivePlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** Absolute, symlink-resolved root. Falls back to `resolve` when the path does not exist. */
export async function canonicalizeRoot(rootPath: string): Promise<string> {
  const resolved = path.resolve(rootPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

/** Vault-relative path with forward slashes and original case. */
export function toDisplayPath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative.split(path.sep).join('/');
}

/** Identity key for a path; see the module comment for why case matters. */
export function toNormalizedPath(
  root: string,
  absolutePath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const display = toDisplayPath(root, absolutePath);
  return isCaseInsensitivePlatform(platform) ? display.toLowerCase() : display;
}

/** Normalizes an already-relative display path (used when replaying stored paths). */
export function normalizeRelative(
  displayPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const unified = displayPath.split('\\').join('/');
  return isCaseInsensitivePlatform(platform) ? unified.toLowerCase() : unified;
}

/**
 * True when `absolutePath` is inside `root`. Rejects `..` traversal and, on Windows,
 * different drives. Callers must canonicalize symlinks before trusting the result for
 * writes (see {@link isSafeWriteTarget}).
 */
export function isInsideVault(root: string, absolutePath: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(absolutePath);
  if (resolvedRoot === resolvedTarget) return true;
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '') return true;
  if (relative.startsWith('..')) return false;
  return !path.isAbsolute(relative);
}

/**
 * Containment check for writes. Resolves the *existing* portion of the path through
 * symlinks so a symlinked directory cannot be used to escape the vault (§20).
 */
export async function isSafeWriteTarget(root: string, absolutePath: string): Promise<boolean> {
  if (!isInsideVault(root, absolutePath)) return false;
  const canonicalRoot = await canonicalizeRoot(root);

  let probe = path.resolve(absolutePath);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      const rebuilt = path.join(real, ...missing);
      return isInsideVault(canonicalRoot, rebuilt);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      missing.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * Markdown detection (FR-2). The extension comparison is case-insensitive on platforms
 * whose filesystems are, so `NOTE.MD` is tracked on Windows and macOS.
 */
export function isMarkdownPath(
  filePath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const extension = path.extname(filePath);
  return isCaseInsensitivePlatform(platform)
    ? extension.toLowerCase() === MARKDOWN_EXTENSION
    : extension === MARKDOWN_EXTENSION;
}

/** Filename component of a vault-relative display path. */
export function basenameOf(displayPath: string): string {
  const parts = displayPath.split('/');
  return parts[parts.length - 1] ?? displayPath;
}

/**
 * Builds `note (recovered).md` style names for occupied recovery destinations (FR-8).
 * Repeats as `note (recovered 2).md` when the first candidate is taken.
 */
export function recoveryCandidateName(fileName: string, attempt: number): string {
  const extension = path.extname(fileName);
  const stem = extension ? fileName.slice(0, -extension.length) : fileName;
  const suffix = attempt <= 1 ? ' (recovered)' : ` (recovered ${attempt})`;
  return `${stem}${suffix}${extension}`;
}
