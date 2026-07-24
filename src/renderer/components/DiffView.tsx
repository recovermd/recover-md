/**
 * Line diff rendering (FR-6).
 *
 * Colour is never the only signal: every row carries a `+`, `−` or space marker and a
 * screen-reader label, so the diff is readable without colour vision (§22).
 */
import React from 'react';
import type { DiffLine, DiffResult } from '@shared/types/domain';
import { AutoHeight, VirtualList, cx } from './ui';

const ROW_HEIGHT = 20;

export function DiffView({ diff }: { diff: DiffResult }): React.JSX.Element {
  if (diff.unsupported) {
    return (
      <div className="p-6 text-[12px] text-muted">
        This version cannot be shown as text, so no diff is available. The exact bytes are still
        stored and can be restored.
      </div>
    );
  }

  if (diff.lines.length === 0) {
    return <div className="p-6 text-[12px] text-muted">No differences.</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-edge px-3 py-1.5 text-[11px]">
        <span className="text-[rgb(var(--rmd-added-ink))]">+{diff.addedLines}</span>
        <span className="text-[rgb(var(--rmd-removed-ink))]">−{diff.removedLines}</span>
        {diff.truncated ? (
          <span className="text-muted">
            The change was too large to align line by line; showing a full replacement.
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        <AutoHeight>
          {(height) => (
            <VirtualList
              items={diff.lines}
              rowHeight={ROW_HEIGHT}
              height={height}
              className="font-mono text-[12px]"
              renderRow={(line, index) => <DiffRow key={index} line={line} />}
            />
          )}
        </AutoHeight>
      </div>
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }): React.JSX.Element {
  const marker = line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' ';
  const label = line.type === 'added' ? 'Added line' : line.type === 'removed' ? 'Removed line' : undefined;

  return (
    <div
      className={cx(
        'flex h-5 items-center gap-0 whitespace-pre',
        line.type === 'added' && 'diff-added',
        line.type === 'removed' && 'diff-removed'
      )}
    >
      <span className="w-12 shrink-0 select-none pr-2 text-right text-[11px] text-muted" aria-hidden>
        {line.oldLine ?? ''}
      </span>
      <span className="w-12 shrink-0 select-none pr-2 text-right text-[11px] text-muted" aria-hidden>
        {line.newLine ?? ''}
      </span>
      <span className="w-4 shrink-0 select-none text-center font-semibold">{marker}</span>
      {label ? <span className="sr-only">{label}: </span> : null}
      <span className="flex-1 overflow-hidden text-ellipsis pr-3">{line.text || ' '}</span>
    </div>
  );
}
