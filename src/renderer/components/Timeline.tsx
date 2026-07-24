/** Right pane: the file timeline, version details and primary actions (FR-5, §21). */
import React from 'react';
import type { TimelineEntry } from '@shared/types/domain';
import {
  GROUP_LABELS,
  eventLabel,
  formatAbsolute,
  formatBytes,
  formatDate,
  formatTime
} from '../lib/format';
import { useAppStore } from '../state/appStore';
import { Badge, Button, EmptyState, cx } from './ui';

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
      <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-edge bg-panel">
        <EmptyState title="No file selected" />
      </aside>
    );
  }

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-edge bg-panel">
      <header className="shrink-0 border-b border-edge px-3 py-2">
        <h2 className="text-[12px] font-semibold">History</h2>
        <p className="text-[11px] text-muted">
          {timeline.reduce((count, group) => count + group.entries.length, 0)} versions
          {pending > 0 ? ' · Recording change…' : ''}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {timeline.length === 0 ? (
          <EmptyState title="No versions yet" description="History begins when Recover.MD first sees the file." />
        ) : (
          timeline.map((group) => (
            <section key={group.key}>
              <h3 className="sticky top-0 z-10 bg-panel px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
                {GROUP_LABELS[group.key] ?? group.key}
              </h3>
              <ul>
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
        <footer className="shrink-0 space-y-2 border-t border-edge px-3 py-3">
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
                <dd className="truncate text-right text-ink" title={selected.previousPath}>
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
    <li>
      <button
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cx(
          'flex w-full flex-col gap-0.5 border-l-2 px-3 py-1.5 text-left transition-colors',
          selected ? 'border-accent bg-surface' : 'border-transparent hover:bg-surface/60'
        )}
      >
        <span className="flex items-center gap-2">
          <span className="text-[12px] font-medium tabular-nums" title={formatAbsolute(entry.capturedAt)}>
            {formatTime(entry.capturedAt)}
          </span>
          <span className="text-[12px]">{eventLabel(entry.eventType, entry.addedLines)}</span>
          {entry.isCurrent ? <Badge tone="accent">current</Badge> : null}
          {entry.eventType === 'delete' ? <Badge tone="negative">deleted</Badge> : null}
        </span>
        <span className="flex items-center gap-3 text-[11px] text-muted">
          {entry.addedLines !== null ? (
            <span className="text-[rgb(var(--rmd-added-ink))]">+{entry.addedLines}</span>
          ) : null}
          {entry.removedLines !== null ? (
            <span className="text-[rgb(var(--rmd-removed-ink))]">−{entry.removedLines}</span>
          ) : null}
          <span>{formatBytes(entry.byteSize)}</span>
          {entry.textUnsupported ? <span>binary</span> : null}
        </span>
        {entry.previousPath ? (
          <span className="truncate text-[10px] text-muted" title={entry.previousPath}>
            was {entry.previousPath}
          </span>
        ) : null}
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
