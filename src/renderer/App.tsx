/** Application shell: three panes, event wiring and keyboard shortcuts (§21, §22). */
import React from 'react';
import { subscribe } from './lib/ipc';
import { useAppStore } from './state/appStore';
import { CenterPane } from './components/CenterPane';
import { HealthBanner } from './components/HealthBanner';
import { LeftPane } from './components/LeftPane';
import { RecoverDialog, RestoreDialog } from './components/Dialogs';
import { SettingsPanel } from './components/SettingsPanel';
import { TimelinePane } from './components/Timeline';
import { TopBar } from './components/TopBar';
import { Button } from './components/ui';

export function App(): React.JSX.Element {
  const initialize = useAppStore((state) => state.initialize);
  const error = useAppStore((state) => state.error);
  const setError = useAppStore((state) => state.setError);
  const searchRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    void initialize();
  }, [initialize]);

  // Main-process events (§16). Each subscription returns its own unsubscribe.
  React.useEffect(() => {
    const store = useAppStore.getState;
    const unsubscribers = [
      subscribe('indexProgress', (progress) => store().applyIndexProgress(progress)),
      subscribe('healthChanged', (health) => store().applyHealth(health)),
      subscribe('trackingStateChanged', () => void store().refreshStatus()),
      subscribe('storageUsageChanged', (usage) => useAppStore.setState({ storage: usage })),
      subscribe('capturePending', () => void store().refreshStatus()),
      subscribe('versionCaptured', (payload) => void store().onVersionCaptured(payload.fileId)),
      subscribe('fileStateChanged', () => void store().refreshFiles())
    ];
    return () => unsubscribers.forEach((off) => off());
  }, []);

  // Keyboard shortcuts (§22).
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const state = useAppStore.getState();
      const modifier = event.metaKey || event.ctrlKey;

      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (modifier && event.shiftKey && event.key.toLowerCase() === 'h') {
        event.preventDefault();
        state.setLeftView('files');
        return;
      }
      if (event.key === 'Escape') {
        if (state.restoreDialog) state.closeRestoreDialog();
        else if (state.recoverDialog) state.closeRecoverDialog();
        else if (state.settingsOpen) state.toggleSettings(false);
        else if (state.viewMode === 'diff') void state.setViewMode('preview');
        return;
      }

      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (typing) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        void state.stepVersion(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        void state.stepVersion(-1);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex h-full flex-col bg-surface text-ink">
      <TopBar searchRef={searchRef} />
      <HealthBanner />
      {error ? (
        <div role="alert" className="flex items-center gap-3 border-b border-edge bg-amber-500/15 px-3 py-2 text-[12px]">
          <span className="flex-1">{error}</span>
          <Button variant="ghost" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}
      <main className="flex min-h-0 flex-1">
        <LeftPane />
        <CenterPane />
        <TimelinePane />
      </main>
      <RestoreDialog />
      <RecoverDialog />
      <SettingsPanel />
    </div>
  );
}
