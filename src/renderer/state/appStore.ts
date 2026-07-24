/**
 * Renderer state (Zustand).
 *
 * The renderer owns no data of its own: every field here is a cached projection of what
 * the main process reported. Actions are thin wrappers over IPC so the UI never has to
 * think about ordering or persistence.
 */
import { create } from 'zustand';
import type {
  AppSettings,
  DiffResult,
  FileSummary,
  HealthStatus,
  IndexProgress,
  RecoverOutcome,
  RestoreOutcome,
  SearchResults,
  SearchScope,
  SkippedFileReport,
  StorageUsage,
  TimelineGroup,
  TrackedFile,
  VaultStatus,
  VersionContent
} from '@shared/types/domain';
import { call } from '../lib/ipc';
import { parseTerms } from '../lib/terms';

export type LeftView = 'files' | 'search' | 'deleted';
export type ViewMode = 'preview' | 'source' | 'diff';

export interface RestoreDialogState {
  versionId: string;
  /** Hash of the on-disk file when the dialog opened; drives conflict detection (AC-12). */
  expectedCurrentHash: string | null;
  conflict: boolean;
  busy: boolean;
  outcome: RestoreOutcome | null;
}

export interface RecoverDialogState {
  versionId: string;
  path: string;
  busy: boolean;
  outcome: RecoverOutcome | null;
}

interface AppState {
  status: VaultStatus | null;
  health: HealthStatus;
  settings: AppSettings | null;
  storage: StorageUsage | null;
  skipped: SkippedFileReport[];
  indexProgress: IndexProgress | null;

  leftView: LeftView;
  files: FileSummary[];
  filesLoading: boolean;
  fileFilterText: string;

  selectedFileId: string | null;
  selectedFile: TrackedFile | null;
  timeline: TimelineGroup[];
  selectedVersionId: string | null;

  currentContent: VersionContent | null;
  versionContent: VersionContent | null;
  diff: DiffResult | null;
  diffLoading: boolean;

  viewMode: ViewMode;
  compareWith: 'previous' | 'current';

  searchText: string;
  searchScope: SearchScope;
  searchResults: SearchResults | null;
  searchTerms: string[];
  searching: boolean;

  settingsOpen: boolean;
  restoreDialog: RestoreDialogState | null;
  recoverDialog: RecoverDialogState | null;
  error: string | null;

  initialize: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  refreshFiles: () => Promise<void>;
  refreshHealth: () => Promise<void>;
  refreshStorage: () => Promise<void>;
  selectVault: () => Promise<void>;
  setLeftView: (view: LeftView) => void;
  setFileFilterText: (value: string) => void;
  selectFile: (fileId: string) => Promise<void>;
  selectVersion: (versionId: string) => Promise<void>;
  stepVersion: (delta: number) => Promise<void>;
  setViewMode: (mode: ViewMode) => Promise<void>;
  setCompareWith: (target: 'previous' | 'current') => Promise<void>;
  setSearchText: (value: string) => void;
  setSearchScope: (scope: SearchScope) => Promise<void>;
  runSearch: () => Promise<void>;
  openRestoreDialog: (versionId: string) => Promise<void>;
  closeRestoreDialog: () => void;
  confirmRestore: (force: boolean) => Promise<void>;
  openRecoverDialog: (versionId: string, path: string) => void;
  closeRecoverDialog: () => void;
  confirmRecover: (onConflict: 'fail' | 'rename' | 'replace') => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  toggleSettings: (open?: boolean) => void;
  pauseOrResume: () => Promise<void>;
  rescan: () => Promise<void>;
  rebuildSearchIndex: () => Promise<void>;
  setError: (message: string | null) => void;
  applyIndexProgress: (progress: IndexProgress) => void;
  applyHealth: (health: HealthStatus) => void;
  applyStatus: (status: VaultStatus) => void;
  onVersionCaptured: (fileId: string) => Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useAppStore = create<AppState>((set, get) => ({
  status: null,
  health: { issues: [], healthy: true },
  settings: null,
  storage: null,
  skipped: [],
  indexProgress: null,

  leftView: 'files',
  files: [],
  filesLoading: false,
  fileFilterText: '',

  selectedFileId: null,
  selectedFile: null,
  timeline: [],
  selectedVersionId: null,

  currentContent: null,
  versionContent: null,
  diff: null,
  diffLoading: false,

  viewMode: 'preview',
  compareWith: 'previous',

  searchText: '',
  searchScope: 'all',
  searchResults: null,
  searchTerms: [],
  searching: false,

  settingsOpen: false,
  restoreDialog: null,
  recoverDialog: null,
  error: null,

  async initialize() {
    try {
      const [status, settings, health] = await Promise.all([
        call('vault:status'),
        call('settings:get'),
        call('health:status')
      ]);
      set({ status, settings, health });
      applyTheme(settings.theme);
      await get().refreshFiles();
      void get().refreshStorage();
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  async refreshStatus() {
    try {
      set({ status: await call('vault:status') });
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  async refreshHealth() {
    try {
      const [health, skipped] = await Promise.all([
        call('health:status'),
        call('health:skippedFiles')
      ]);
      set({ health, skipped });
    } catch {
      // Health is best-effort; a failure here must not break the UI.
    }
  },

  async refreshStorage() {
    try {
      set({ storage: await call('storage:usage') });
    } catch {
      /* ignore */
    }
  },

  async refreshFiles() {
    const { leftView, fileFilterText } = get();
    set({ filesLoading: true });
    try {
      const files = await call('file:list', {
        filter: leftView === 'deleted' ? 'deleted' : 'active',
        query: fileFilterText || undefined,
        limit: 1000,
        offset: 0
      });
      set({ files, filesLoading: false });
    } catch (error) {
      set({ error: describe(error), filesLoading: false });
    }
  },

  async selectVault() {
    try {
      const status = await call('vault:select');
      set({ status, selectedFileId: null, selectedFile: null, timeline: [] });
      await get().refreshFiles();
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  setLeftView(view) {
    set({ leftView: view });
    if (view !== 'search') void get().refreshFiles();
  },

  setFileFilterText(value) {
    set({ fileFilterText: value });
    void get().refreshFiles();
  },

  async selectFile(fileId) {
    set({
      selectedFileId: fileId,
      selectedVersionId: null,
      versionContent: null,
      diff: null,
      timeline: []
    });
    try {
      const [file, timeline, current] = await Promise.all([
        call('file:get', { fileId }),
        call('timeline:get', { fileId }),
        call('file:currentContent', { fileId })
      ]);
      set({ selectedFile: file, timeline, currentContent: current });
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  async selectVersion(versionId) {
    set({ selectedVersionId: versionId, diff: null });
    try {
      const content = await call('version:content', { versionId });
      set({ versionContent: content });
      if (get().viewMode === 'diff') await loadDiff(set, get);
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  /** Arrow-key navigation through the timeline (§22). */
  async stepVersion(delta) {
    const { timeline, selectedVersionId } = get();
    const flat = timeline.flatMap((group) => group.entries);
    if (flat.length === 0) return;
    const index = flat.findIndex((entry) => entry.id === selectedVersionId);
    const next = index === -1 ? 0 : Math.min(flat.length - 1, Math.max(0, index + delta));
    const target = flat[next];
    if (target && target.id !== selectedVersionId) await get().selectVersion(target.id);
  },

  async setViewMode(mode) {
    set({ viewMode: mode });
    if (mode === 'diff') await loadDiff(set, get);
  },

  async setCompareWith(target) {
    set({ compareWith: target });
    if (get().viewMode === 'diff') await loadDiff(set, get);
  },

  setSearchText(value) {
    set({ searchText: value });
  },

  async setSearchScope(scope) {
    set({ searchScope: scope });
    await get().runSearch();
  },

  async runSearch() {
    const { searchText, searchScope } = get();
    if (searchText.trim().length === 0) {
      set({ searchResults: null, searchTerms: [] });
      return;
    }
    set({ searching: true, leftView: 'search' });
    try {
      const results = await call('search:versions', {
        text: searchText,
        scope: searchScope,
        limit: 25,
        offset: 0
      });
      set({ searchResults: results, searchTerms: parseTerms(searchText), searching: false });
    } catch (error) {
      set({ error: describe(error), searching: false });
    }
  },

  async openRestoreDialog(versionId) {
    const fileId = get().selectedFileId;
    let expected: string | null = null;
    if (fileId) {
      const current = await call('file:currentContent', { fileId }).catch(() => null);
      expected = current?.hash ?? null;
      set({ currentContent: current });
    }
    set({ restoreDialog: { versionId, expectedCurrentHash: expected, conflict: false, busy: false, outcome: null } });
  },

  closeRestoreDialog() {
    set({ restoreDialog: null });
  },

  async confirmRestore(force) {
    const dialog = get().restoreDialog;
    if (!dialog) return;
    set({ restoreDialog: { ...dialog, busy: true } });
    try {
      const outcome = await call('version:restore', {
        versionId: dialog.versionId,
        expectedCurrentHash: dialog.expectedCurrentHash,
        force
      });
      if (outcome.status === 'conflict') {
        set({
          restoreDialog: {
            ...dialog,
            busy: false,
            conflict: true,
            // Adopt the new hash so a second confirmation targets what is on disk now.
            expectedCurrentHash: outcome.currentHash,
            outcome
          }
        });
        return;
      }
      set({ restoreDialog: { ...dialog, busy: false, outcome } });
      const fileId = get().selectedFileId;
      if (fileId) await get().selectFile(fileId);
      await get().refreshFiles();
    } catch (error) {
      set({ error: describe(error), restoreDialog: { ...dialog, busy: false } });
    }
  },

  openRecoverDialog(versionId, path) {
    set({ recoverDialog: { versionId, path, busy: false, outcome: null } });
  },

  closeRecoverDialog() {
    set({ recoverDialog: null });
  },

  async confirmRecover(onConflict) {
    const dialog = get().recoverDialog;
    if (!dialog) return;
    set({ recoverDialog: { ...dialog, busy: true } });
    try {
      const outcome = await call('file:recoverDeleted', {
        versionId: dialog.versionId,
        onConflict,
        createParentDirectories: true
      });
      set({ recoverDialog: { ...dialog, busy: false, outcome } });
      await get().refreshFiles();
      const fileId = get().selectedFileId;
      if (fileId && outcome.status === 'recovered') await get().selectFile(fileId);
    } catch (error) {
      set({ error: describe(error), recoverDialog: { ...dialog, busy: false } });
    }
  },

  async updateSettings(patch) {
    try {
      const settings = await call('settings:update', patch);
      set({ settings });
      applyTheme(settings.theme);
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  toggleSettings(open) {
    set({ settingsOpen: open ?? !get().settingsOpen });
  },

  async pauseOrResume() {
    const state = get().status?.trackingState;
    try {
      const status = state === 'paused' ? await call('vault:resumeTracking') : await call('vault:pauseTracking');
      set({ status });
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  async rescan() {
    try {
      set({ status: await call('vault:rescan') });
      await get().refreshFiles();
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  async rebuildSearchIndex() {
    try {
      await call('search:rebuildIndex');
      await get().refreshHealth();
    } catch (error) {
      set({ error: describe(error) });
    }
  },

  setError(message) {
    set({ error: message });
  },

  applyIndexProgress(progress) {
    set({ indexProgress: progress.phase === 'done' ? null : progress });
    if (progress.phase === 'done') void get().refreshFiles();
  },

  applyHealth(health) {
    set({ health });
  },

  applyStatus(status) {
    set({ status });
  },

  /** A new version landed for a file: refresh its timeline if it is the one on screen. */
  async onVersionCaptured(fileId) {
    if (get().selectedFileId !== fileId) return;
    try {
      const [timeline, current] = await Promise.all([
        call('timeline:get', { fileId }),
        call('file:currentContent', { fileId })
      ]);
      set({ timeline, currentContent: current });
    } catch {
      /* ignore */
    }
  }
}));

async function loadDiff(
  set: (partial: Partial<AppState>) => void,
  get: () => AppState
): Promise<void> {
  const { selectedVersionId, compareWith } = get();
  if (!selectedVersionId) {
    set({ diff: null });
    return;
  }
  set({ diffLoading: true });
  try {
    const diff = await call('version:diff', { versionId: selectedVersionId, compareWith });
    set({ diff, diffLoading: false });
  } catch (error) {
    set({ error: describe(error), diffLoading: false, diff: null });
  }
}

/** Applies the theme preference, following the system when set to `system` (§22). */
export function applyTheme(theme: AppSettings['theme']): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = theme === 'dark' || (theme === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', dark);
}
