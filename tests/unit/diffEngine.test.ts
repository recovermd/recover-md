import { describe, expect, it } from 'vitest';
import { computeLineDiff, computeLineStats } from '../../src/main/diff/diffEngine';

describe('computeLineDiff', () => {
  it('reports added and removed lines with correct numbering', () => {
    const before = 'alpha\nbeta\ngamma\n';
    const after = 'alpha\ndelta\ngamma\nepsilon\n';
    const diff = computeLineDiff(before, after);

    expect(diff.addedLines).toBe(2);
    expect(diff.removedLines).toBe(1);
    expect(diff.unsupported).toBe(false);

    const removed = diff.lines.filter((line) => line.type === 'removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.text).toBe('beta');
    expect(removed[0]?.oldLine).toBe(2);
    expect(removed[0]?.newLine).toBeNull();

    const added = diff.lines.filter((line) => line.type === 'added').map((line) => line.text);
    expect(added).toEqual(['delta', 'epsilon']);
  });

  it('treats CRLF and LF as the same separator without altering the text', () => {
    const diff = computeLineDiff('one\r\ntwo\r\n', 'one\ntwo\n');
    expect(diff.addedLines).toBe(0);
    expect(diff.removedLines).toBe(0);
  });

  it('handles a missing final newline', () => {
    const diff = computeLineDiff('one\ntwo', 'one\ntwo\n');
    expect(diff.addedLines).toBe(0);
    expect(diff.removedLines).toBe(0);
  });

  it('handles empty files on either side', () => {
    expect(computeLineDiff('', '')).toMatchObject({ addedLines: 0, removedLines: 0, lines: [] });
    expect(computeLineDiff('', 'a\nb\n')).toMatchObject({ addedLines: 2, removedLines: 0 });
    expect(computeLineDiff('a\nb\n', '')).toMatchObject({ addedLines: 0, removedLines: 2 });
  });

  it('marks non-text input as unsupported instead of guessing', () => {
    expect(computeLineDiff(null, 'a').unsupported).toBe(true);
    expect(computeLineDiff('a', null).unsupported).toBe(true);
  });

  it('is deterministic for identical inputs', () => {
    const a = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const b = a.replace('line 50', 'changed 50').replace('line 120', 'changed 120');
    expect(JSON.stringify(computeLineDiff(a, b))).toBe(JSON.stringify(computeLineDiff(a, b)));
  });

  it('degrades to a whole replacement when the edit budget is exceeded', () => {
    const a = Array.from({ length: 400 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 400 }, (_, i) => `b${i}`).join('\n');
    const diff = computeLineDiff(a, b, { maxEditLength: 4 });
    expect(diff.truncated).toBe(true);
    expect(diff.addedLines).toBe(400);
    expect(diff.removedLines).toBe(400);
  });

  it('preserves line ordering', () => {
    const diff = computeLineDiff('a\nb\nc\n', 'a\nx\nb\nc\n');
    const texts = diff.lines.map((line) => line.text);
    expect(texts).toEqual(['a', 'x', 'b', 'c']);
  });
});

describe('computeLineStats', () => {
  it('counts every line as added when there is no predecessor', () => {
    expect(computeLineStats(null, 'a\nb\n')).toEqual({
      lineCount: 2,
      addedLines: 2,
      removedLines: 0
    });
  });

  it('returns nulls when the new content is not text', () => {
    expect(computeLineStats('a\n', null)).toEqual({
      lineCount: null,
      addedLines: null,
      removedLines: null
    });
  });

  it('computes the delta against the previous version', () => {
    expect(computeLineStats('a\nb\n', 'a\nb\nc\n')).toEqual({
      lineCount: 3,
      addedLines: 1,
      removedLines: 0
    });
  });
});
