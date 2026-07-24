/** Settings (FR-11) and the storage/privacy disclosure (§20). */
import React from 'react';
import { MAX_SNAPSHOT_DELAY_MS, MIN_SNAPSHOT_DELAY_MS } from '@shared/constants';
import { formatBytes } from '../lib/format';
import { call } from '../lib/ipc';
import { useAppStore } from '../state/appStore';
import { Button, Modal } from './ui';

export function SettingsPanel(): React.JSX.Element | null {
  const open = useAppStore((state) => state.settingsOpen);
  const toggle = useAppStore((state) => state.toggleSettings);
  const settings = useAppStore((state) => state.settings);
  const status = useAppStore((state) => state.status);
  const storage = useAppStore((state) => state.storage);
  const update = useAppStore((state) => state.updateSettings);
  const selectVault = useAppStore((state) => state.selectVault);
  const rescan = useAppStore((state) => state.rescan);
  const rebuild = useAppStore((state) => state.rebuildSearchIndex);
  const pauseOrResume = useAppStore((state) => state.pauseOrResume);
  const refreshStorage = useAppStore((state) => state.refreshStorage);

  const [patterns, setPatterns] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setPatterns((settings?.ignorePatterns ?? []).join('\n'));
      void refreshStorage();
    }
  }, [open, settings, refreshStorage]);

  if (!open || !settings) return null;

  return (
    <Modal title="Settings" onClose={() => toggle(false)} footer={<Button onClick={() => toggle(false)}>Close</Button>}>
      <div className="space-y-4">
        <section>
          <h3 className="mb-1 text-[12px] font-semibold">Vault folder</h3>
          <p className="mb-2 break-all text-muted">{status?.vault?.rootPath ?? 'No folder selected'}</p>
          <Button onClick={() => void selectVault()}>Choose folder…</Button>
        </section>

        <section>
          <h3 className="mb-1 text-[12px] font-semibold">Snapshot delay</h3>
          <p className="mb-2 text-muted">
            How long a file must stay unchanged before a version is recorded. Continuous editing is
            still captured at least once a minute.
          </p>
          <label className="flex items-center gap-3">
            <input
              type="range"
              min={MIN_SNAPSHOT_DELAY_MS}
              max={MAX_SNAPSHOT_DELAY_MS}
              step={1000}
              value={settings.snapshotDelayMs}
              onChange={(event) => void update({ snapshotDelayMs: Number(event.target.value) })}
              className="flex-1"
              aria-label="Snapshot delay in milliseconds"
            />
            <span className="w-16 text-right tabular-nums">{(settings.snapshotDelayMs / 1000).toFixed(0)}s</span>
          </label>
        </section>

        <section>
          <h3 className="mb-1 text-[12px] font-semibold">Ignore patterns</h3>
          <p className="mb-2 text-muted">One glob per line, in addition to the built-in exclusions.</p>
          <textarea
            value={patterns}
            onChange={(event) => setPatterns(event.target.value)}
            onBlur={() =>
              void update({
                ignorePatterns: patterns
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0)
              })
            }
            rows={4}
            className="w-full rounded border border-edge bg-surface p-2 font-mono text-[11px] outline-none"
            aria-label="Additional ignore patterns"
          />
        </section>

        <section className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.launchAtLogin}
              onChange={(event) => void update({ launchAtLogin: event.target.checked })}
            />
            <span>Start Recover.MD at login</span>
          </label>
          <label className="flex items-center gap-2">
            <span>Theme</span>
            <select
              value={settings.theme}
              onChange={(event) =>
                void update({ theme: event.target.value as 'system' | 'light' | 'dark' })
              }
              className="rounded border border-edge bg-surface px-2 py-1"
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </section>

        <section className="flex flex-wrap gap-2">
          <Button onClick={() => void pauseOrResume()}>
            {status?.trackingState === 'paused' ? 'Resume tracking' : 'Pause tracking'}
          </Button>
          <Button onClick={() => void rescan()}>Rescan vault</Button>
          <Button onClick={() => void rebuild()}>Rebuild search index</Button>
          <Button onClick={() => void call('app:openDataFolder')}>Open application-data folder</Button>
          <Button onClick={() => void call('app:openLogsFolder')}>Open logs folder</Button>
        </section>
        {status?.trackingState === 'paused' ? (
          <p className="rounded border border-edge bg-amber-500/15 p-2 text-[11px]">
            Tracking is paused. Changes to your files are not being recorded.
          </p>
        ) : null}

        <section>
          <h3 className="mb-1 text-[12px] font-semibold">Storage</h3>
          {storage ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted">
              <dt>Tracked files</dt>
              <dd className="text-right text-ink">{storage.fileCount}</dd>
              <dt>Stored versions</dt>
              <dd className="text-right text-ink">{storage.versionCount}</dd>
              <dt>Unique content blocks</dt>
              <dd className="text-right text-ink">{storage.blobCount}</dd>
              <dt>Content before compression</dt>
              <dd className="text-right text-ink">{formatBytes(storage.blobRawBytes)}</dd>
              <dt>Content after compression</dt>
              <dd className="text-right text-ink">{formatBytes(storage.blobCompressedBytes)}</dd>
              <dt>Database</dt>
              <dd className="text-right text-ink">{formatBytes(storage.databaseBytes)}</dd>
              <dt>Backups</dt>
              <dd className="text-right text-ink">{formatBytes(storage.backupBytes)}</dd>
            </dl>
          ) : (
            <p className="text-muted">Calculating…</p>
          )}
        </section>

        <section className="rounded border border-edge bg-panel p-2 text-[11px] leading-relaxed text-muted">
          <p className="font-medium text-ink">Where your history lives</p>
          <p>
            Everything stays on this machine — there is no account, no sync and no network access.
            Historical note content, including text you later deleted, is stored in a local database
            that is not encrypted by Recover.MD. It is protected by your operating-system account and
            whatever disk encryption you use.
          </p>
        </section>
      </div>
    </Modal>
  );
}
