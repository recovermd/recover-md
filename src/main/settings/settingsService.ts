/**
 * Settings commands. Side effects (ignore-pattern refresh, launch-at-login) stay here so
 * the IPC router does not reach into the store or the OS.
 */
import type { AppSettings } from '@shared/types/domain';
import type { Store } from '../storage/store';

export interface SettingsServiceHooks {
  onIgnorePatternsChanged?: () => void;
  applyLaunchAtLogin?: (enabled: boolean) => void;
}

export class SettingsService {
  constructor(
    private readonly store: Store,
    private readonly hooks: SettingsServiceHooks = {}
  ) {}

  get(): AppSettings {
    return this.store.settings.get();
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const updated = this.store.settings.update(patch);
    if (patch.ignorePatterns !== undefined) this.hooks.onIgnorePatternsChanged?.();
    if (patch.launchAtLogin !== undefined) this.hooks.applyLaunchAtLogin?.(updated.launchAtLogin);
    return updated;
  }
}
