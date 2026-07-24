/** Key/value settings (§14.6) with typed accessors for the MVP setting set (FR-11). */
import {
  DEFAULT_SNAPSHOT_DELAY_MS,
  MAX_SNAPSHOT_DELAY_MS,
  MIN_SNAPSHOT_DELAY_MS
} from '@shared/constants';
import type { AppSettings } from '@shared/types/domain';
import type { Database } from '../database';

const KEYS = {
  snapshotDelayMs: 'snapshot_delay_ms',
  ignorePatterns: 'ignore_patterns',
  launchAtLogin: 'launch_at_login',
  theme: 'theme',
  activeVaultId: 'active_vault_id',
  searchIndexStale: 'search_index_stale'
} as const;

export const DEFAULT_SETTINGS: AppSettings = {
  snapshotDelayMs: DEFAULT_SNAPSHOT_DELAY_MS,
  ignorePatterns: [],
  launchAtLogin: true,
  theme: 'system'
};

function clampDelay(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SNAPSHOT_DELAY_MS;
  return Math.min(MAX_SNAPSHOT_DELAY_MS, Math.max(MIN_SNAPSHOT_DELAY_MS, Math.round(value)));
}

export class SettingsRepository {
  constructor(private readonly db: Database) {}

  private raw(key: string): string | null {
    return this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null;
  }

  private write(key: string, value: string): void {
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, Date.now()]
    );
  }

  get(): AppSettings {
    const delayRaw = this.raw(KEYS.snapshotDelayMs);
    const patternsRaw = this.raw(KEYS.ignorePatterns);
    const launchRaw = this.raw(KEYS.launchAtLogin);
    const themeRaw = this.raw(KEYS.theme);

    let ignorePatterns: string[] = [];
    if (patternsRaw) {
      try {
        const parsed: unknown = JSON.parse(patternsRaw);
        if (Array.isArray(parsed)) {
          ignorePatterns = parsed.filter((p): p is string => typeof p === 'string');
        }
      } catch {
        ignorePatterns = [];
      }
    }

    const theme = themeRaw === 'light' || themeRaw === 'dark' ? themeRaw : 'system';

    return {
      snapshotDelayMs: delayRaw ? clampDelay(Number(delayRaw)) : DEFAULT_SETTINGS.snapshotDelayMs,
      ignorePatterns,
      launchAtLogin: launchRaw === null ? DEFAULT_SETTINGS.launchAtLogin : launchRaw === '1',
      theme
    };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    if (patch.snapshotDelayMs !== undefined) {
      this.write(KEYS.snapshotDelayMs, String(clampDelay(patch.snapshotDelayMs)));
    }
    if (patch.ignorePatterns !== undefined) {
      this.write(KEYS.ignorePatterns, JSON.stringify(patch.ignorePatterns));
    }
    if (patch.launchAtLogin !== undefined) {
      this.write(KEYS.launchAtLogin, patch.launchAtLogin ? '1' : '0');
    }
    if (patch.theme !== undefined) {
      this.write(KEYS.theme, patch.theme);
    }
    return this.get();
  }

  getActiveVaultId(): string | null {
    return this.raw(KEYS.activeVaultId);
  }

  setActiveVaultId(id: string): void {
    this.write(KEYS.activeVaultId, id);
  }

  isSearchIndexStale(): boolean {
    return this.raw(KEYS.searchIndexStale) === '1';
  }

  setSearchIndexStale(stale: boolean): void {
    this.write(KEYS.searchIndexStale, stale ? '1' : '0');
  }
}
