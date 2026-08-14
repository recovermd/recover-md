/**
 * Window and tray management (FR-10, §20).
 *
 * Closing the window hides it: Recover.MD keeps watching from the tray, because history
 * that stops when the window closes is not a safety net.
 */
import path from 'node:path';
import { BrowserWindow, Menu, Tray, app, nativeImage, shell } from 'electron';
import type { TrackingState } from '@shared/types/domain';
import { trackingStatusLabel } from '@shared/copy';
import { TRAY_ICON_DATA_URL } from './trayIcon';

export interface WindowManagerOptions {
  preloadPath: string;
  rendererUrl: string | null;
  rendererFile: string;
  onQuitRequested: () => void;
  onPauseToggle: () => void;
  getTrackingState: () => TrackingState;
  getActiveFileCount?: () => number;
  openLogsFolder: () => void;
  openDataFolder: () => void;
}

export class WindowManager {
  private window: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private quitting = false;

  constructor(private readonly options: WindowManagerOptions) {}

  get mainWindow(): BrowserWindow | null {
    return this.window;
  }

  markQuitting(): void {
    this.quitting = true;
  }

  createWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return this.window;
    }

    const window = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 600,
      show: false,
      backgroundColor: '#f3ead9',
      title: 'Recover.MD',
      webPreferences: {
        preload: this.options.preloadPath,
        // §20: the renderer is sandboxed, isolated and has no Node access.
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false
      }
    });

    window.once('ready-to-show', () => window.show());

    // External links open in the system browser; the app itself never navigates away.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      const allowed = this.options.rendererUrl;
      if (allowed && url.startsWith(allowed)) return;
      event.preventDefault();
    });

    window.on('close', (event) => {
      if (this.quitting) return;
      // FR-10: closing the window leaves tracking running in the tray.
      event.preventDefault();
      window.hide();
    });

    window.on('closed', () => {
      this.window = null;
    });

    if (this.options.rendererUrl) {
      void window.loadURL(this.options.rendererUrl);
    } else {
      void window.loadFile(this.options.rendererFile);
    }

    this.window = window;
    return window;
  }

  show(): void {
    const window = this.createWindow();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  createTray(): void {
    if (this.tray) return;
    const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('Recover.MD');
    tray.on('click', () => this.show());
    tray.on('double-click', () => this.show());
    this.tray = tray;
    this.refreshTray();
  }

  /** Keeps the tray menu's status line in sync with the tracking state (FR-10). */
  refreshTray(): void {
    if (!this.tray) return;
    const state = this.options.getTrackingState();
    const label = trackingStatusLabel(state, this.options.getActiveFileCount?.());
    const pauseLabel = state === 'paused' ? 'Resume watching' : 'Pause watching';

    const menu = Menu.buildFromTemplate([
      { label: `Recover.MD — ${label}`, enabled: false },
      { type: 'separator' },
      { label: 'Open Recover.MD', click: () => this.show() },
      {
        label: pauseLabel,
        click: () => this.options.onPauseToggle()
      },
      { type: 'separator' },
      { label: 'Open application data folder', click: () => this.options.openDataFolder() },
      { label: 'Open logs folder', click: () => this.options.openLogsFolder() },
      { type: 'separator' },
      { label: 'Quit Recover.MD', click: () => this.options.onQuitRequested() }
    ]);

    this.tray.setContextMenu(menu);
    this.tray.setToolTip(`Recover.MD — ${label}`);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}

/** Resolves a path inside the packaged app, accounting for asar unpacking. */
export function resolveAppPath(...segments: string[]): string {
  return path.join(app.getAppPath(), ...segments);
}

/** Same as {@link resolveAppPath} but pointing at the unpacked copy when packaged. */
export function resolveUnpackedPath(...segments: string[]): string {
  return resolveAppPath(...segments).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}
