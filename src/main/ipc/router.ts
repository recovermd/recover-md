/**
 * IPC request router (§16).
 *
 * One entry point, one validation step, one error envelope. The renderer can only reach
 * capabilities listed here, and only with payloads that pass their zod schema (§20).
 */
import type { ChannelName, IpcResult } from '@shared/contracts/ipc';
import { requestSchemas } from '@shared/validation/schemas';
import type {
  AppSettings,
  RecoverRequest,
  RestoreRequest,
  SearchQuery,
  VaultStatus
} from '@shared/types/domain';
import type { DiffRequest, ListFilesRequest, TimelineRequest } from '@shared/contracts/ipc';
import type { HistoryService } from '../history/historyService';
import type { HealthMonitor } from '../health/healthMonitor';
import type { Logger } from '../logging/logger';
import type { RestoreService } from '../restore/restoreService';
import type { SearchService } from '../search/searchService';
import type { Store } from '../storage/store';
import type { VaultCoordinator } from '../vault/vaultCoordinator';

export interface RouterDependencies {
  store: Store;
  coordinator: VaultCoordinator;
  history: HistoryService;
  search: SearchService;
  restore: RestoreService;
  health: HealthMonitor;
  logger: Logger;
  /** Opens the OS folder picker; returns null when the user cancels. */
  selectFolder: () => Promise<string | null>;
  /** Applies the launch-at-login preference to the OS. */
  applyLaunchAtLogin: (enabled: boolean) => void;
  /** Reveals a local folder in the OS file manager (FR-11). */
  openFolder: (which: 'data' | 'logs') => void;
}

export type RouterHandler = (channel: string, payload: unknown) => Promise<IpcResult<unknown>>;

export function createRouter(deps: RouterDependencies): RouterHandler {
  const handlers: Record<ChannelName, (payload: never) => Promise<unknown> | unknown> = {
    // ------------------------------------------------------------- commands
    'vault:select': async (): Promise<VaultStatus> => {
      const folder = await deps.selectFolder();
      if (!folder) return deps.coordinator.status();
      return deps.coordinator.openVault(folder);
    },
    'vault:startTracking': () => deps.coordinator.startTracking(),
    'vault:pauseTracking': () => deps.coordinator.pauseTracking(),
    'vault:resumeTracking': () => deps.coordinator.resumeTracking(),
    'vault:rescan': () => deps.coordinator.rescan(),
    'version:restore': (request: RestoreRequest) => deps.restore.restore(request),
    'file:recoverDeleted': (request: RecoverRequest) => deps.restore.recoverDeleted(request),
    'settings:update': (patch: Partial<AppSettings>): AppSettings => {
      const updated = deps.store.settings.update(patch);
      if (patch.ignorePatterns !== undefined) deps.coordinator.onSettingsChanged();
      if (patch.launchAtLogin !== undefined) deps.applyLaunchAtLogin(updated.launchAtLogin);
      return updated;
    },
    'search:rebuildIndex': async () => {
      const result = await deps.search.rebuildIndex();
      deps.health.clear('search_index_stale');
      return result;
    },
    'app:openDataFolder': () => {
      deps.openFolder('data');
      return null;
    },
    'app:openLogsFolder': () => {
      deps.openFolder('logs');
      return null;
    },

    // -------------------------------------------------------------- queries
    'vault:status': () => deps.coordinator.status(),
    'file:list': (request: ListFilesRequest) => {
      const vault = deps.coordinator.currentVault;
      if (!vault) return [];
      return deps.store.files.list(
        vault.id,
        request.filter,
        request.query,
        request.limit ?? 500,
        request.offset ?? 0
      );
    },
    'file:get': (request: { fileId: string }) => deps.store.files.byId(request.fileId),
    'file:currentContent': (request: { fileId: string }) =>
      deps.history.getCurrentContent(request.fileId),
    'timeline:get': (request: TimelineRequest) =>
      deps.history.getTimeline(request.fileId, request.limit ?? 500, request.offset ?? 0),
    'version:content': (request: { versionId: string }) =>
      deps.history.getVersionContent(request.versionId),
    'version:diff': (request: DiffRequest) => deps.history.getDiff(request),
    'search:versions': (query: SearchQuery) => deps.search.search(query),
    'storage:usage': () => deps.history.getStorageUsage(),
    'health:status': () => deps.health.status(),
    'health:skippedFiles': () => {
      const vault = deps.coordinator.currentVault;
      return vault ? deps.store.skipped.list(vault.id) : [];
    },
    'settings:get': () => deps.store.settings.get()
  };

  return async (channel: string, payload: unknown): Promise<IpcResult<unknown>> => {
    const schema = (requestSchemas as Record<string, { safeParse: (value: unknown) => { success: boolean; data?: unknown } }>)[
      channel
    ];
    const handler = handlers[channel as ChannelName];

    if (!schema || !handler) {
      deps.logger.warn('Rejected unknown IPC channel', { channel });
      return { ok: false, error: { code: 'unknown_channel', message: `Unknown channel: ${channel}` } };
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      deps.logger.warn('Rejected invalid IPC payload', { channel });
      return {
        ok: false,
        error: { code: 'invalid_payload', message: `Invalid payload for ${channel}` }
      };
    }

    try {
      const data = await handler(parsed.data as never);
      return { ok: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.logger.error('IPC handler failed', { channel, error: message });
      return { ok: false, error: { code: 'handler_failed', message } };
    }
  };
}
