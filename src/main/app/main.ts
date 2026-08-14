/**
 * Application entry point.
 *
 * Wires storage, tracking, IPC and the window/tray shell together, and enforces the two
 * product-level guarantees that have to live at this layer:
 *   - the app makes no network requests of its own (§20)
 *   - closing the window does not stop tracking (FR-10)
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, powerMonitor, session, shell } from 'electron';
import type { EventMap, EventName } from '@shared/contracts/ipc';
import { HealthMonitor } from '../health/healthMonitor';
import { HistoryService } from '../history/historyService';
import { createRouter } from '../ipc/router';
import { createLogger } from '../logging/logger';
import { DiffWorkerClient } from '../diff/diffWorkerClient';
import { CatalogService } from '../files/catalogService';
import { RestoreService } from '../restore/restoreService';
import { SearchService } from '../search/searchService';
import { SettingsService } from '../settings/settingsService';
import { Store } from '../storage/store';
import { VaultCoordinator } from '../vault/vaultCoordinator';
import { WindowManager, resolveAppPath, resolveUnpackedPath } from './windows';

const isDevelopment = !app.isPackaged;
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'] ?? null;

app.setName('Recover.MD');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void start();
}

async function start(): Promise<void> {
  await app.whenReady();

  const dataDir = app.getPath('userData');
  const logsDir = path.join(dataDir, 'logs');

  const logger = createLogger({
    directory: logsDir,
    minLevel: isDevelopment ? 'debug' : 'info',
    console: isDevelopment
  });
  logger.info('Starting Recover.MD', { version: app.getVersion(), platform: process.platform });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
  });

  hardenSession();

  const health = new HealthMonitor();
  const store = await Store.open({ dataDir });

  if (store.report.restoredFromBackup) {
    logger.warn('Database restored from backup', { backup: store.report.restoredFromBackup });
    health.raise(
      'database_unavailable',
      'warning',
      'The history database was damaged and has been restored from a backup.',
      { detail: 'Versions recorded after that backup may be missing.' }
    );
  }
  if (store.safeMode) {
    health.raise(
      'database_safe_mode',
      'error',
      'The history database is open in read-only safe mode. New changes are not being recorded.',
      { detail: 'The damaged database has been kept for diagnostics.' }
    );
  }
  if (!store.safeMode && store.settings.isSearchIndexStale()) {
    health.raise('search_index_stale', 'warning', 'The search index needs to be rebuilt.');
  }

  const windows = new WindowManager({
    preloadPath: resolveAppPath('out', 'preload', 'index.cjs'),
    rendererUrl: rendererDevUrl,
    rendererFile: resolveAppPath('out', 'renderer', 'index.html'),
    onQuitRequested: () => void quit(),
    onPauseToggle: () => {
      void (coordinator.trackingState === 'paused'
        ? coordinator.resumeTracking()
        : coordinator.pauseTracking());
    },
    getTrackingState: () => coordinator.trackingState,
    getActiveFileCount: () => coordinator.status().activeFileCount,
    openLogsFolder: () => void shell.openPath(logsDir),
    openDataFolder: () => void shell.openPath(dataDir)
  });

  const broadcast = <E extends EventName>(event: E, payload: EventMap[E]): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send('recover:event', { name: event, payload });
    }
  };

  const coordinator = new VaultCoordinator({
    store,
    logger: logger.child('vault'),
    health,
    dataDir,
    events: {
      emit: (event, payload) => {
        broadcast(event, payload);
        if (event === 'trackingStateChanged') windows.refreshTray();
      }
    }
  });

  const workerPath = resolveUnpackedPath('out', 'main', 'cpuWorker.js');
  const diff = new DiffWorkerClient({
    workerPath: existsSync(workerPath) ? workerPath : null,
    logger: logger.child('diff')
  });

  const history = new HistoryService({
    store,
    diff,
    resolvePath: (displayPath) => coordinator.absolutePathFor(displayPath)
  });
  const search = new SearchService(store, logger.child('search'));
  const restore = new RestoreService({
    store,
    logger: logger.child('restore'),
    health,
    context: () => coordinator.captureContext()
  });

  health.onChange((status) => broadcast('healthChanged', status));

  const catalog = new CatalogService(store, () => coordinator.currentVault?.id ?? null);
  const settings = new SettingsService(store, {
    onIgnorePatternsChanged: () => coordinator.onSettingsChanged(),
    applyLaunchAtLogin: (enabled) => {
      if (isDevelopment) return;
      app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    }
  });

  const router = createRouter({
    catalog,
    settings,
    coordinator,
    history,
    search,
    restore,
    health,
    logger: logger.child('ipc'),
    selectFolder: async () => {
      const window = windows.mainWindow;
      const result = window
        ? await dialog.showOpenDialog(window, {
            title: 'Choose the folder Recover.MD should protect',
            properties: ['openDirectory', 'createDirectory']
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    openFolder: (which) => {
      void shell.openPath(which === 'logs' ? logsDir : dataDir);
    }
  });

  ipcMain.handle('recover:invoke', async (_event, channel: string, payload: unknown) =>
    router(channel, payload)
  );

  windows.createTray();
  windows.createWindow();

  // Apply the stored launch-at-login preference (FR-10).
  if (!isDevelopment) {
    app.setLoginItemSettings({
      openAtLogin: store.settings.get().launchAtLogin,
      openAsHidden: true
    });
  }

  await coordinator.resumeLastVault();
  windows.refreshTray();

  // §19.6: verify the watcher and reconcile after the machine wakes.
  powerMonitor.on('resume', () => void coordinator.handleSystemWake());
  powerMonitor.on('unlock-screen', () => void coordinator.reconcile('periodic_reconciliation'));

  const usageTimer = setInterval(() => {
    void history
      .getStorageUsage()
      .then((usage) => broadcast('storageUsageChanged', usage))
      .catch(() => undefined);
  }, 60_000);
  usageTimer.unref?.();

  app.on('second-instance', () => windows.show());
  app.on('activate', () => windows.show());
  // FR-10: the app deliberately keeps running with no windows open.
  app.on('window-all-closed', () => undefined);

  let quitting = false;
  async function quit(): Promise<void> {
    if (quitting) return;
    quitting = true;
    logger.info('Quitting; flushing pending captures');
    windows.markQuitting();
    clearInterval(usageTimer);
    try {
      await coordinator.stopTracking();
      await diff.dispose();
      store.close();
    } catch (error) {
      logger.error('Error during shutdown', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    windows.destroy();
    await logger.close();
    app.exit(0);
  }

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void quit();
  });
}

/**
 * Blocks every outbound request and installs a strict CSP.
 *
 * Recover.MD has no server, no telemetry and no remote assets; anything trying to leave
 * the machine is a bug or an injected Markdown embed, and both must fail closed (§20).
 */
function hardenSession(): void {
  const allowedPrefixes = ['file://', 'devtools://', 'blob:', 'data:'];
  if (rendererDevUrl) allowedPrefixes.push(rendererDevUrl, 'ws://localhost', 'http://localhost');

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = allowedPrefixes.some((prefix) => details.url.startsWith(prefix));
    callback({ cancel: !allowed });
  });

  const csp = isDevelopment
    ? "default-src 'self' 'unsafe-inline' data: blob: http://localhost:* ws://localhost:*"
    : "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    });
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
