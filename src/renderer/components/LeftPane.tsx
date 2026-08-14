/** Left pane: file list, search results and the deleted-files view (§21). */
import React from 'react';
import type { SearchScope } from '@shared/types/domain';
import { formatDate, formatTime, eventLabel, fileName, parentPath } from '../lib/format';
import { highlightTerms } from '../lib/markdown';
import { useAppStore } from '../state/appStore';
import { Badge, EmptyState, Segmented, cx } from './ui';

export function LeftPane(): React.JSX.Element {
  const leftView = useAppStore((state) => state.leftView);
  const setLeftView = useAppStore((state) => state.setLeftView);

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-edge bg-panel">
      <div className="flex items-center gap-2 border-b border-edge px-3 py-2.5">
        <Segmented
          ariaLabel="Left pane view"
          value={leftView}
          onChange={(value) => setLeftView(value)}
          options={[
            { value: 'files', label: 'Files' },
            { value: 'search', label: 'Search' },
            { value: 'deleted', label: 'Deleted' }
          ]}
        />
      </div>
      {leftView === 'search' ? <SearchResultsList /> : <FileList />}
    </aside>
  );
}

function FileList(): React.JSX.Element {
  const files = useAppStore((state) => state.files);
  const loading = useAppStore((state) => state.filesLoading);
  const selectedFileId = useAppStore((state) => state.selectedFileId);
  const selectFile = useAppStore((state) => state.selectFile);
  const filterText = useAppStore((state) => state.fileFilterText);
  const setFilterText = useAppStore((state) => state.setFileFilterText);
  const leftView = useAppStore((state) => state.leftView);
  const status = useAppStore((state) => state.status);

  return (
    <>
      <div className="border-b border-edge p-3">
        <input
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
          placeholder="Filter by path…"
          aria-label="Filter files by path"
          className="w-full rounded-md border border-edge bg-surface px-2.5 py-1.5 text-[12px] outline-none placeholder:text-muted"
        />
      </div>
      <div className="flex-1 overflow-auto">
        {!status?.vault ? (
          <EmptyState title="No folder yet" description="Choose a folder to start recording history." />
        ) : loading && files.length === 0 ? (
          <EmptyState title="Loading…" />
        ) : files.length === 0 ? (
          <EmptyState
            title={leftView === 'deleted' ? 'No deleted files' : 'No Markdown files yet'}
            description={
              leftView === 'deleted'
                ? 'Deleted files stay here with their full history.'
                : 'Recover.MD tracks .md files inside the selected folder.'
            }
          />
        ) : (
          <ul role="listbox" aria-label="Tracked files">
            {files.map((file) => {
              const selected = file.id === selectedFileId;
              const parent = parentPath(file.currentPath);
              const deleted = file.status === 'deleted';
              return (
                <li key={file.id}>
                  <button
                    role="option"
                    aria-selected={selected}
                    onClick={() => void selectFile(file.id)}
                    className={cx(
                      'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors',
                      selected ? 'bg-accent/15' : 'hover:bg-surface/70'
                    )}
                  >
                    <span className="flex w-full items-center gap-2">
                      <span
                        className={cx(
                          'truncate text-[13px] font-medium',
                          deleted && 'text-[rgb(var(--rmd-removed-ink))] line-through decoration-[1.5px]'
                        )}
                      >
                        {fileName(file.currentPath)}
                      </span>
                    </span>
                    <span className="flex w-full items-center justify-between gap-2 font-mono text-[10px] text-muted">
                      <span className="truncate">{parent || '/'}</span>
                      <span className="shrink-0">
                        {file.versionCount} {file.versionCount === 1 ? 'version' : 'versions'}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function SearchResultsList(): React.JSX.Element {
  const results = useAppStore((state) => state.searchResults);
  const searching = useAppStore((state) => state.searching);
  const terms = useAppStore((state) => state.searchTerms);
  const scope = useAppStore((state) => state.searchScope);
  const setScope = useAppStore((state) => state.setSearchScope);
  const selectFile = useAppStore((state) => state.selectFile);
  const selectVersion = useAppStore((state) => state.selectVersion);
  const openRecover = useAppStore((state) => state.openRecoverDialog);

  const scopes: { value: SearchScope; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'current', label: 'Current' },
    { value: 'historical', label: 'History' },
    { value: 'deleted', label: 'Deleted' }
  ];

  return (
    <>
      <div className="flex flex-wrap gap-1 border-b border-edge p-3">
        {scopes.map((option) => (
          <button
            key={option.value}
            onClick={() => void setScope(option.value)}
            aria-pressed={scope === option.value}
            className={cx(
              'rounded-full border px-2.5 py-0.5 text-[11px]',
              scope === option.value ? 'border-accent bg-accent/10 text-accent' : 'border-edge text-muted hover:text-ink'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {searching ? (
          <EmptyState title="Searching…" />
        ) : !results ? (
          <EmptyState title="Search your history" description="Find text that only exists in an older version." />
        ) : results.groups.length === 0 ? (
          <EmptyState title="No results" description="Try fewer words, or widen the scope." />
        ) : (
          <ul>
            {results.groups.map((group) => (
              <li key={group.fileId} className="border-b border-edge/60 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span
                    className={cx(
                      'truncate text-[13px] font-medium',
                      group.fileStatus === 'deleted' &&
                        'text-[rgb(var(--rmd-removed-ink))] line-through decoration-[1.5px]'
                    )}
                  >
                    {fileName(group.currentPath)}
                  </span>
                </div>
                <p className="truncate font-mono text-[10px] text-muted">{group.currentPath}</p>
                <ul className="mt-1.5 space-y-1">
                  {group.matches.map((match) => (
                    <li key={match.versionId}>
                      <button
                        onClick={() => {
                          void selectFile(match.fileId).then(() => selectVersion(match.versionId));
                        }}
                        className="w-full rounded-md border border-transparent px-2 py-1 text-left hover:border-edge hover:bg-surface"
                      >
                        <span className="flex items-center gap-2 text-[11px] text-muted">
                          <span>{formatDate(match.capturedAt)}</span>
                          <span>{formatTime(match.capturedAt)}</span>
                          <span>{eventLabel(match.eventType, null)}</span>
                          {match.isCurrent ? <Badge tone="accent">current</Badge> : null}
                        </span>
                        <span
                          className="mt-0.5 block text-[12px] leading-snug text-ink"
                          dangerouslySetInnerHTML={{ __html: highlightTerms(match.snippet, terms) }}
                        />
                      </button>
                      {group.fileStatus === 'deleted' ? (
                        <button
                          className="ml-2 text-[11px] text-accent underline"
                          onClick={() => openRecover(match.versionId, group.currentPath)}
                        >
                          Recover file
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {results?.hasMore ? (
          <p className="p-3 text-[11px] text-muted">More results available — refine your search to narrow them.</p>
        ) : null}
      </div>
    </>
  );
}
