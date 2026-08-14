/** Right pane: the file timeline, version details and primary actions (FR-5, §21). */
import React from 'react';
import type { TimelineEntry } from '@shared/types/domain';
import {
  GROUP_LABELS,
  eventLabel,
  formatAbsolute,
  formatBytes,
  formatDate,
  formatRelative,
  formatTime
} from '../lib/format';
import { useAppStore } from '../state/appStore';
import { Button, EmptyState, cx } from './ui';

export function TimelinePane(): React.JSX.Element {
  const timeline = useAppStore((state) => state.timeline);
  const selectedFile = useAppStore((state) => state.selectedFile);
  const selectedVersionId = useAppStore((state) => state.selectedVersionId);
  const selectVersion = useAppStore((state) => state.selectVersion);
  const openRestore = useAppStore((state) => state.openRestoreDialog);
  const openRecover = useAppStore((state) => state.openRecoverDialog);
  const versionContent = useAppStore((state) => state.versionContent);
  const pending = useAppStore((state) => state.status?.pendingCaptures ?? 0);

  const selected = React.useMemo(
    () => timeline.flatMap((group) => group.entries).find((entry) => entry.id === selectedVersionId) ?? null,
    [timeline, selectedVersionId]
  );

  if (!selectedFile) {
    return (
      <aside className="flex h-full w-[300px] shrink-0 flex-col border-l border-edge bg-panel">
        <EmptyState title="No file selected" />
      </aside>
    );
  }

  const versionCount = timeline.reduce((count, group) => count + group.entries.length, 0);

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-l border-edge bg-panel">
      <header className="shrink-0 border-b border-edge px-4 py-3">
        <h2 className="font-display text-[16px] font-medium tracking-tight">History</h2>
        <p className="text-[11px] text-muted">
          {versionCount} {versionCount === 1 ? 'version' : 'versions'}
          {pending > 0 ? ' · Recording change…' : ''}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {timeline.length === 0 ? (
          <EmptyState title="No versions yet" description="History begins when Recover.MD first sees the file." />
        ) : (
          timeline.map((group) => (
            <section key={group.key} className="mb-3">
              <h3 className="sticky top-0 z-10 bg-panel px-1 py-1.5 font-display text-[11px] font-medium tracking-wide text-muted">
                {GROUP_LABELS[group.key] ?? group.key}
              </h3>
              <ul className="relative ml-[7px] border-l border-edge">
                {group.entries.map((entry) => (
                  <TimelineRow
                    key={entry.id}
                    entry={entry}
                    selected={entry.id === selectedVersionId}
                    onSelect={() => void selectVersion(entry.id)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {selected ? (
        <footer className="shrink-0 space-y-3 border-t border-edge px-4 py-3">
          <dl className="space-y-1 text-[11px] text-muted">
            <div className="flex justify-between gap-2">
              <dt>Captured</dt>
              <dd className="text-right text-ink" title={formatAbsolute(selected.capturedAt)}>
                {formatDate(selected.capturedAt)} {formatTime(selected.capturedAt)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Event</dt>
              <dd className="text-ink">{eventLabel(selected.eventType, selected.addedLines)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Size</dt>
              <dd className="text-ink">{formatBytes(selected.byteSize)}</dd>
            </div>
            {selected.previousPath ? (
              <div className="flex justify-between gap-2">
                <dt>Path then</dt>
                <dd className="truncate text-right font-mono text-[10px] text-ink" title={selected.previousPath}>
                  {selected.previousPath}
                </dd>
              </div>
            ) : null}
            {selected.label ? (
              <div className="flex justify-between gap-2">
                <dt>Note</dt>
                <dd className="text-right text-ink">{selected.label}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-2">
              <dt>Discovered by</dt>
              <dd className="text-ink">{ORIGIN_LABELS[selected.origin] ?? selected.origin}</dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-2">
            {selectedFile.status === 'deleted' ? (
              <Button
                variant="primary"
                onClick={() => openRecover(selected.id, selectedFile.currentPath)}
                disabled={!selected.blobHash}
              >
                Recover file
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void openRestore(selected.id)}
                disabled={!selected.blobHash || selected.isCurrent}
              >
                Restore this version
              </Button>
            )}
            <Button
              onClick={() => {
                if (versionContent?.text) void navigator.clipboard.writeText(versionContent.text);
              }}
              disabled={!versionContent?.text}
              title="Copy this version's content to the clipboard"
            >
              Copy content
            </Button>
          </div>
          <p className="text-[10px] leading-snug text-muted">
            Restoring writes the stored bytes back and adds a new entry. Nothing is removed from
            history.
          </p>
        </footer>
      ) : null}
    </aside>
  );
}

function TimelineRow({
  entry,
  selected,
  onSelect
}: {
  entry: TimelineEntry;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <li className="relative">
      <button
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cx(
          'flex w-full items-start gap-3 py-2 pl-0 pr-1 text-left transition-colors',
          selected ? 'bg-accent/10' : 'hover:bg-surface/60'
        )}
      >
        <span
          className={cx(
            'relative z-10 mt-1.5 -ml-[5px] h-2.5 w-2.5 shrink-0 rounded-full border-2 bg-panel',
            selected || entry.isCurrent ? 'border-accent bg-accent' : 'border-edge'
          )}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="font-display text-[13px] font-medium leading-tight">
              {eventLabel(entry.eventType, entry.addedLines)}
            </span>
            <span className="shrink-0 font-mono text-[10px] tabular-nums">
              {entry.addedLines !== null ? (
                <span className="text-[rgb(var(--rmd-added-ink))]">+{entry.addedLines}</span>
              ) : null}
              {entry.addedLines !== null && entry.removedLines !== null ? ' ' : null}
              {entry.removedLines !== null ? (
                <span className="text-[rgb(var(--rmd-removed-ink))]">−{entry.removedLines}</span>
              ) : null}
            </span>
          </span>
          <span className="mt-0.5 block text-[11px] text-muted" title={formatAbsolute(entry.capturedAt)}>
            {formatTime(entry.capturedAt)}
            {entry.isCurrent ? ` · ${formatRelative(entry.capturedAt)}` : null}
          </span>
          {entry.previousPath ? (
            <span className="mt-0.5 block truncate font-mono text-[10px] text-muted" title={entry.previousPath}>
              was {entry.previousPath}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/**
 * How Recover.MD found out about a change. Deliberately never names an application or an
 * AI agent: filesystem events do not carry that information (§2).
 */
const ORIGIN_LABELS: Record<string, string> = {
  initial_scan: 'First scan',
  watcher: 'Live tracking',
  startup_reconciliation: 'Found at startup',
  periodic_reconciliation: 'Found during a check',
  restore: 'Restore',
  recovery: 'Recovery'
};
