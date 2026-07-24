/**
 * Atomic file replacement (FR-7).
 *
 * Writes to a temporary file in the *same directory* (so the rename stays on one
 * filesystem), flushes it to disk, then renames over the destination. A crash therefore
 * leaves either the old file or the new one — never a half-written note.
 */
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export interface AtomicWriteOptions {
  /** Permission bits to apply, normally copied from the file being replaced. */
  mode?: number;
}

export async function atomicWriteFile(
  destination: string,
  bytes: Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const directory = path.dirname(destination);
  const tempName = `.recovermd-${randomBytes(6).toString('hex')}.tmp`;
  const tempPath = path.join(directory, tempName);

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tempPath, 'wx', options.mode ?? 0o644);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;

    if (options.mode !== undefined) {
      await fs.chmod(tempPath, options.mode).catch(() => undefined);
    }

    await fs.rename(tempPath, destination);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Reads a file's permission bits, or undefined when it does not exist. */
export async function readMode(filePath: string): Promise<number | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return stat.mode & 0o777;
  } catch {
    return undefined;
  }
}
