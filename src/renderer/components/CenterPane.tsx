/** Centre pane: Markdown preview, raw source and diff (FR-6, §21). */
import React from 'react';
import { renderMarkdown } from '../lib/markdown';
import { formatAbsolute, formatBytes, fileName, parentPath } from '../lib/format';
import { useAppStore } from '../state/appStore';
import { AutoHeight, Badge, Button, EmptyState, Segmented, VirtualList } from './ui';
import { DiffView } from './DiffView';

export function CenterPane(): React.JSX.Element {
  const selectedFile = useAppStore((state) => state.selectedFile);
  const selectedVersionId = useAppStore((state) => state.selectedVersionId);
  const versionContent = useAppStore((state) => state.versionContent);
  const currentContent = useAppStore((state) => state.currentContent);
  const viewMode = useAppStore((state) => state.viewMode);
  const setViewMode = useAppStore((state) => state.setViewMode);
  const compareWith = useAppStore((state) => state.compareWith);
  const setCompareWith = useAppStore((state) => state.setCompareWith);
  const diff = useAppStore((state) => state.diff);
  const diffLoading = useAppStore((state) => state.diffLoading);
  const status = useAppStore((state) => state.status);
  const selectVault = useAppStore((state) => state.selectVault);
  const timeline = useAppStore((state) => state.timeline);

  if (!status?.vault) {
    return (
      <section className="flex-1">
        <EmptyState
          title="Choose the folder Recover.MD should protect"
          description="Everything stays on this machine. History starts when you select the folder — versions from before that are not available."
          action={
            <Button variant="primary" onClick={() => void selectVault()}>
              Select folder…
            </Button>
          }
        />
      </section>
    );
  }

  if (!selectedFile) {
    return (
      <section className="flex-1">
        <EmptyState title="Pick a file" description="Its captured states appear here, ready to restore." />
      </section>
    );
  }

  const showing = selectedVersionId ? versionContent : currentContent;
  const isHistorical = Boolean(selectedVersionId);
  const selectedEntry = timeline.flatMap((group) => group.entries).find((entry) => entry.id === selectedVersionId);
  const parent = parentPath(selectedFile.currentPath);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-surface">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-edge px-5 py-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-muted" title={selectedFile.currentPath}>
            {parent ? `${parent} / ` : ''}
            <span className="text-ink">{fileName(selectedFile.currentPath)}</span>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
            {isHistorical ? (
              <Badge tone="accent">historical</Badge>
            ) : (
              <Badge tone="positive">current file</Badge>
            )}
            {selectedFile.status === 'deleted' ? <Badge tone="negative">deleted from disk</Badge> : null}
            {selectedEntry ? (
              <span title={formatAbsolute(selectedEntry.capturedAt)}>{formatAbsolute(selectedEntry.capturedAt)}</span>
            ) : null}
            {showing ? <span>{formatBytes(showing.byteSize)}</span> : null}
            {showing?.hasBom ? <span>UTF-8 BOM</span> : null}
            {showing && !showing.encodingSupported ? <span>not valid UTF-8</span> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {viewMode === 'diff' ? (
            <Segmented
              ariaLabel="Diff comparison target"
              value={compareWith}
              onChange={(value) => void setCompareWith(value)}
              options={[
                { value: 'previous', label: 'vs previous' },
                { value: 'current', label: 'vs current' }
              ]}
            />
          ) : null}
          <Segmented
            ariaLabel="View mode"
            value={viewMode}
            onChange={(value) => void setViewMode(value)}
            options={[
              { value: 'preview', label: 'Preview' },
              { value: 'source', label: 'Source' },
              { value: 'diff', label: 'Diff' }
            ]}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {viewMode === 'diff' ? (
          diffLoading ? (
            <EmptyState title="Computing diff…" />
          ) : diff ? (
            <DiffView diff={diff} />
          ) : (
            <EmptyState
              title="Select a version to compare"
              description="Choose a version in the timeline to see what changed."
            />
          )
        ) : !showing ? (
          <EmptyState title="Nothing to show" />
        ) : !showing.encodingSupported ? (
          <EmptyState
            title="This file is not valid UTF-8"
            description="Preview, diff and search are unavailable, but the exact bytes are stored and can be restored."
          />
        ) : viewMode === 'preview' ? (
          <MarkdownPreview source={showing.text ?? ''} />
        ) : (
          <SourceView text={showing.text ?? ''} />
        )}
      </div>
    </section>
  );
}

function MarkdownPreview({ source }: { source: string }): React.JSX.Element {
  const html = React.useMemo(() => renderMarkdown(source), [source]);
  return (
    <div className="h-full overflow-auto px-10 py-8">
      <article className="markdown-body mx-auto max-w-2xl" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/** Raw source, virtualized so a 10 MB note does not stall the renderer. */
function SourceView({ text }: { text: string }): React.JSX.Element {
  const lines = React.useMemo(() => text.split(/\r\n|\r|\n/), [text]);
  return (
    <AutoHeight>
      {(height) => (
        <VirtualList
          items={lines}
          rowHeight={20}
          height={height}
          className="px-4 py-3 font-mono text-[12px]"
          renderRow={(line, index) => (
            <div key={index} className="flex h-5 items-center whitespace-pre">
              <span className="w-12 shrink-0 select-none pr-3 text-right text-[11px] text-muted">
                {index + 1}
              </span>
              <span className="flex-1">{line || ' '}</span>
            </div>
          )}
        />
      )}
    </AutoHeight>
  );
}
