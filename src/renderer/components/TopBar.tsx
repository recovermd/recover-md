/** Top bar: vault, global search, protection status, settings. */
import React from 'react';
import { trackingStatusLabel } from '@shared/copy';
import type { TrackingState } from '@shared/types/domain';
import { useAppStore } from '../state/appStore';
import { Button, cx } from './ui';

const STATE_TONE: Record<TrackingState, string> = {
  starting: 'bg-muted',
  indexing: 'bg-accent',
  active: 'bg-accent',
  paused: 'bg-amber-600',
  degraded: 'bg-amber-600',
  unavailable: 'bg-[rgb(var(--rmd-removed-ink))]',
  stopped: 'bg-[rgb(var(--rmd-removed-ink))]'
};

export function TopBar({ searchRef }: { searchRef: React.RefObject<HTMLInputElement> }): React.JSX.Element {
  const status = useAppStore((state) => state.status);
  const searchText = useAppStore((state) => state.searchText);
  const setSearchText = useAppStore((state) => state.setSearchText);
  const runSearch = useAppStore((state) => state.runSearch);
  const toggleSettings = useAppStore((state) => state.toggleSettings);
  const pauseOrResume = useAppStore((state) => state.pauseOrResume);
  const indexProgress = useAppStore((state) => state.indexProgress);

  const trackingState = status?.trackingState ?? 'stopped';
  const vaultName = status?.vault?.rootPath.split(/[\\/]/).filter(Boolean).pop() ?? 'No folder selected';
  const statusLabel = trackingStatusLabel(trackingState, status?.activeFileCount);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-edge bg-panel/80 px-4">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <span className="font-display text-[17px] font-semibold tracking-tight">Recover.MD</span>
        <span className="truncate font-mono text-[11px] text-muted" title={status?.vault?.rootPath ?? undefined}>
          {vaultName}
        </span>
      </div>

      <div className="flex flex-1 justify-center">
        <input
          ref={searchRef}
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void runSearch();
          }}
          placeholder="Search current and historical content…   Ctrl/Cmd+K"
          aria-label="Search versions"
          className="w-[min(560px,100%)] rounded-full border border-edge bg-surface px-4 py-1.5 text-[12px] outline-none placeholder:text-muted"
        />
      </div>

      <div className="flex items-center gap-2">
        {indexProgress ? (
          <span className="text-[11px] text-muted" aria-live="polite">
            Indexing {indexProgress.processed}/{indexProgress.total}
          </span>
        ) : null}
        {status?.pendingCaptures ? (
          <span className="text-[11px] text-muted" aria-live="polite">
            Recording change…
          </span>
        ) : null}
        <button
          onClick={() => void pauseOrResume()}
          title="Toggle watching"
          className="flex items-center gap-1.5 rounded-full border border-edge bg-surface px-2.5 py-1 text-[11px] text-muted hover:text-ink"
        >
          <span className={cx('h-2 w-2 rounded-full', STATE_TONE[trackingState])} aria-hidden />
          {statusLabel}
        </button>
        <Button variant="ghost" onClick={() => toggleSettings()} aria-label="Settings">
          Settings
        </Button>
      </div>
    </header>
  );
}
