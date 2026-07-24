/**
 * Line-based diff engine (§17).
 *
 * Uses a deterministic Myers diff over *interned* lines: identical inputs always produce
 * identical output. The diff is a view — it is never used to reconstruct content (§13).
 *
 * CRLF and LF are compared as equal line separators, but nothing here ever rewrites the
 * stored bytes; normalization exists only for comparison.
 */
import { diffArrays } from 'diff';
import { DIFF_MAX_EDIT_LENGTH } from '@shared/constants';
import type { DiffLine, DiffResult } from '@shared/types/domain';
import { splitLines } from '../vault/text';

interface ArrayOptionsWithBudget {
  maxEditLength?: number;
  comparator?: (left: number, right: number) => boolean;
}

/** Maps each distinct line to an integer so the diff compares numbers, not strings. */
function intern(a: string[], b: string[]): { left: number[]; right: number[]; table: string[] } {
  const ids = new Map<string, number>();
  const table: string[] = [];
  const toId = (line: string): number => {
    const existing = ids.get(line);
    if (existing !== undefined) return existing;
    const id = table.length;
    ids.set(line, id);
    table.push(line);
    return id;
  };
  return { left: a.map(toId), right: b.map(toId), table };
}

export interface DiffOptions {
  /** Beyond this edit distance the diff degrades to "replace everything". */
  maxEditLength?: number;
}

/**
 * Computes a line diff between two documents.
 *
 * `null` input means "not decodable as text": the result is marked `unsupported` rather
 * than guessing, because a wrong diff is worse than no diff (FR-2).
 */
export function computeLineDiff(
  oldText: string | null,
  newText: string | null,
  options: DiffOptions = {}
): DiffResult {
  if (oldText === null || newText === null) {
    return { lines: [], addedLines: 0, removedLines: 0, truncated: false, unsupported: true };
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length === 0 && newLines.length === 0) {
    return { lines: [], addedLines: 0, removedLines: 0, truncated: false, unsupported: false };
  }

  const { left, right } = intern(oldLines, newLines);
  const budget = options.maxEditLength ?? DIFF_MAX_EDIT_LENGTH;

  const changes = diffArrays(left, right, {
    maxEditLength: budget
  } as ArrayOptionsWithBudget) as
    | { value: number[]; added?: boolean; removed?: boolean }[]
    | undefined;

  if (!changes) {
    // Budget exceeded: fall back to a whole-document replacement so the UI still shows
    // something correct (every old line removed, every new line added).
    return wholeReplacement(oldLines, newLines);
  }

  const lines: DiffLine[] = [];
  let oldNumber = 1;
  let newNumber = 1;
  let added = 0;
  let removed = 0;

  for (const change of changes) {
    const count = change.value.length;
    if (change.added) {
      for (let i = 0; i < count; i += 1) {
        lines.push({ type: 'added', oldLine: null, newLine: newNumber, text: newLines[newNumber - 1] ?? '' });
        newNumber += 1;
        added += 1;
      }
    } else if (change.removed) {
      for (let i = 0; i < count; i += 1) {
        lines.push({ type: 'removed', oldLine: oldNumber, newLine: null, text: oldLines[oldNumber - 1] ?? '' });
        oldNumber += 1;
        removed += 1;
      }
    } else {
      for (let i = 0; i < count; i += 1) {
        lines.push({
          type: 'context',
          oldLine: oldNumber,
          newLine: newNumber,
          text: oldLines[oldNumber - 1] ?? ''
        });
        oldNumber += 1;
        newNumber += 1;
      }
    }
  }

  return { lines, addedLines: added, removedLines: removed, truncated: false, unsupported: false };
}

function wholeReplacement(oldLines: string[], newLines: string[]): DiffResult {
  const lines: DiffLine[] = [];
  oldLines.forEach((text, index) => {
    lines.push({ type: 'removed', oldLine: index + 1, newLine: null, text });
  });
  newLines.forEach((text, index) => {
    lines.push({ type: 'added', oldLine: null, newLine: index + 1, text });
  });
  return {
    lines,
    addedLines: newLines.length,
    removedLines: oldLines.length,
    truncated: true,
    unsupported: false
  };
}

export interface LineStats {
  lineCount: number | null;
  addedLines: number | null;
  removedLines: number | null;
}

/**
 * Added/removed counts stored on a version (FR-4). Returns nulls when either side is not
 * text, so the timeline can say "not available" instead of showing a misleading `+0 −0`.
 */
export function computeLineStats(previousText: string | null, currentText: string | null): LineStats {
  if (currentText === null) {
    return { lineCount: null, addedLines: null, removedLines: null };
  }
  const lineCount = splitLines(currentText).length;
  if (previousText === null) {
    // No comparable predecessor: every line is new.
    return { lineCount, addedLines: lineCount, removedLines: 0 };
  }
  const diff = computeLineDiff(previousText, currentText);
  if (diff.unsupported) return { lineCount, addedLines: null, removedLines: null };
  return { lineCount, addedLines: diff.addedLines, removedLines: diff.removedLines };
}
