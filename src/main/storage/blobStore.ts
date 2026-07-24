/**
 * Content-addressed blob storage (§13).
 *
 * Every unique version is stored as a complete, compressed copy of the original bytes.
 * Diffs are computed on demand from two blobs — they are never the source of truth.
 *
 * Compression uses Brotli via the async zlib API so the work happens on the libuv thread
 * pool rather than the main event loop. If compression does not pay for itself the raw
 * bytes are stored with the `identity` codec.
 */
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { BlobCodec } from '@shared/types/domain';
import type { Database } from './database';

const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

export interface StoredBlob {
  hash: string;
  codec: BlobCodec;
  rawSize: number;
  compressedSize: number;
  /** True when this exact content was already present and no new row was written. */
  deduplicated: boolean;
}

export interface BlobRow {
  hash: string;
  codec: BlobCodec;
  compressed_data: Uint8Array;
  raw_size: number;
  compressed_size: number;
  created_at: number;
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function compress(
  bytes: Uint8Array
): Promise<{ codec: BlobCodec; data: Buffer }> {
  if (bytes.byteLength === 0) {
    return { codec: 'identity', data: Buffer.alloc(0) };
  }
  const compressed = await brotliCompress(bytes, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength
    }
  });
  if (compressed.byteLength >= bytes.byteLength) {
    return { codec: 'identity', data: Buffer.from(bytes) };
  }
  return { codec: 'brotli', data: compressed };
}

export async function decompress(codec: BlobCodec, data: Uint8Array): Promise<Buffer> {
  if (codec === 'identity') return Buffer.from(data);
  return brotliDecompress(data);
}

export class BlobStore {
  constructor(private readonly db: Database) {}

  /**
   * Stores bytes and returns their content identity. Storing the same content twice is a
   * no-op, which is what keeps a long history of small edits cheap.
   */
  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const hash = hashBytes(bytes);
    const existing = this.db.get<{ codec: BlobCodec; raw_size: number; compressed_size: number }>(
      'SELECT codec, raw_size, compressed_size FROM blobs WHERE hash = ?',
      [hash]
    );
    if (existing) {
      return {
        hash,
        codec: existing.codec,
        rawSize: existing.raw_size,
        compressedSize: existing.compressed_size,
        deduplicated: true
      };
    }

    const { codec, data } = await compress(bytes);
    this.db.run(
      `INSERT OR IGNORE INTO blobs (hash, codec, compressed_data, raw_size, compressed_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [hash, codec, data, bytes.byteLength, data.byteLength, Date.now()]
    );
    return {
      hash,
      codec,
      rawSize: bytes.byteLength,
      compressedSize: data.byteLength,
      deduplicated: false
    };
  }

  /**
   * Inserts a blob inside an already-open transaction. Compression must be done ahead of
   * time by {@link prepare} so no async work happens while the transaction is held.
   */
  putPreparedSync(prepared: PreparedBlob): void {
    this.db.run(
      `INSERT OR IGNORE INTO blobs (hash, codec, compressed_data, raw_size, compressed_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        prepared.hash,
        prepared.codec,
        prepared.data,
        prepared.rawSize,
        prepared.data.byteLength,
        Date.now()
      ]
    );
  }

  /** Hashes and compresses without touching the database. */
  static async prepare(bytes: Uint8Array): Promise<PreparedBlob> {
    const hash = hashBytes(bytes);
    const { codec, data } = await compress(bytes);
    return { hash, codec, data, rawSize: bytes.byteLength };
  }

  exists(hash: string): boolean {
    return this.db.get<{ one: number }>('SELECT 1 AS one FROM blobs WHERE hash = ?', [hash]) != null;
  }

  /** Returns the exact original bytes, or null when the blob is unknown. */
  async get(hash: string): Promise<Buffer | null> {
    const row = this.db.get<BlobRow>(
      'SELECT hash, codec, compressed_data, raw_size, compressed_size, created_at FROM blobs WHERE hash = ?',
      [hash]
    );
    if (!row) return null;
    const bytes = await decompress(row.codec, row.compressed_data);
    if (bytes.byteLength !== row.raw_size) {
      throw new Error(
        `Blob ${hash} decompressed to ${bytes.byteLength} bytes, expected ${row.raw_size}`
      );
    }
    return bytes;
  }

  /** Verifies that stored bytes still hash to their identity (used before a restore). */
  async verify(hash: string): Promise<boolean> {
    const bytes = await this.get(hash);
    if (!bytes) return false;
    return hashBytes(bytes) === hash;
  }

  stats(): { count: number; rawBytes: number; compressedBytes: number } {
    const row = this.db.get<{ count: number; raw: number | null; compressed: number | null }>(
      'SELECT COUNT(*) AS count, SUM(raw_size) AS raw, SUM(compressed_size) AS compressed FROM blobs'
    );
    return {
      count: row?.count ?? 0,
      rawBytes: row?.raw ?? 0,
      compressedBytes: row?.compressed ?? 0
    };
  }
}

export interface PreparedBlob {
  hash: string;
  codec: BlobCodec;
  data: Buffer;
  rawSize: number;
}
