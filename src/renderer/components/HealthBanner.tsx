/** Persistent health warnings (FR-12). Errors are never auto-dismissed. */
import React from 'react';
import { useAppStore } from '../state/appStore';
import { cx } from './ui';

export function HealthBanner(): React.JSX.Element | null {
  const health = useAppStore((state) => state.health);
  const skipped = useAppStore((state) => state.skipped);
  const rebuild = useAppStore((state) => state.rebuildSearchIndex);
  const [expanded, setExpanded] = React.useState(false);

  if (health.issues.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-edge">
      {health.issues.map((issue) => (
        <div
          key={issue.code}
          role={issue.severity === 'error' ? 'alert' : 'status'}
          className={cx(
            'flex items-start gap-2 px-4 py-2 text-[12px]',
            issue.severity === 'error'
              ? 'bg-[rgb(var(--rmd-removed-bg))] text-[rgb(var(--rmd-removed-ink))]'
              : 'bg-amber-700/15 text-ink'
          )}
        >
          <span aria-hidden className="font-semibold">
            {issue.severity === 'error' ? '!' : '•'}
          </span>
          <div className="flex-1">
            <p className="font-medium">{issue.message}</p>
            {issue.detail ? <p className="text-muted">{issue.detail}</p> : null}
            {issue.code === 'file_too_large' || issue.code === 'file_unreadable' ? (
              <button className="mt-1 underline" onClick={() => setExpanded((value) => !value)}>
                {expanded ? 'Hide affected files' : `Show affected files (${skipped.length})`}
              </button>
            ) : null}
            {issue.code === 'search_index_stale' ? (
              <button className="mt-1 underline" onClick={() => void rebuild()}>
                Rebuild search index
              </button>
            ) : null}
            {expanded && (issue.code === 'file_too_large' || issue.code === 'file_unreadable') ? (
              <ul className="mt-1 max-h-32 overflow-auto font-mono text-[11px] text-muted">
                {skipped.map((entry) => (
                  <li key={entry.path}>
                    {entry.path} — {entry.detail}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
