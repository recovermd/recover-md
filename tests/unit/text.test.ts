import { describe, expect, it } from 'vitest';
import { bucketFor } from '../../src/main/history/historyService';
import { countLines, decodeUtf8, endsWithoutNewline, hasUtf8Bom, splitLines } from '../../src/main/vault/text';

describe('text helpers', () => {
  it('splits lines without inventing a trailing empty line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('\n')).toEqual(['']);
  });

  it('treats CRLF as a single separator', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(countLines('a\r\nb')).toBe(2);
  });

  it('detects a UTF-8 BOM', () => {
    expect(hasUtf8Bom(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe(true);
    expect(hasUtf8Bom(Buffer.from('abc'))).toBe(false);
  });

  it('decodes valid UTF-8 and refuses invalid bytes', () => {
    expect(decodeUtf8(Buffer.from('héllo', 'utf8'))).toBe('héllo');
    expect(decodeUtf8(Buffer.from([0xff, 0xfe, 0x00, 0x80]))).toBeNull();
  });

  it('reports a missing final newline', () => {
    expect(endsWithoutNewline('abc')).toBe(true);
    expect(endsWithoutNewline('abc\n')).toBe(false);
    expect(endsWithoutNewline('')).toBe(false);
  });
});

describe('timeline buckets', () => {
  const now = new Date('2026-07-24T15:00:00');

  it('uses the local calendar rather than fixed 24-hour windows', () => {
    expect(bucketFor(new Date('2026-07-24T00:05:00').getTime(), now)).toBe('today');
    expect(bucketFor(new Date('2026-07-23T23:55:00').getTime(), now)).toBe('yesterday');
    expect(bucketFor(new Date('2026-07-20T10:00:00').getTime(), now)).toBe('this_week');
    expect(bucketFor(new Date('2026-06-01T10:00:00').getTime(), now)).toBe('older');
  });
});
