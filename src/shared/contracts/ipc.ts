/**
 * Typed IPC contract between renderer and main (§16).
 *
 * The renderer never touches the filesystem or the database; every capability it has is
 * enumerated here. Channel names are namespaced so a stray `ipcRenderer.invoke` from an
 * unexpected caller is easy to spot in logs.
 */
import type {
  AppSettings,
  DiffResult,
  FileSummary,
  HealthStatus,
  IndexProgress,
  RecoverOutcome,
  RecoverRequest,
  RestoreOutcome,
  RestoreRequest,
  SearchQuery,
  SearchResults,
  SkippedFileReport,
  StorageUsage,
  TimelineGroup,
  TrackedFile,
  TrackingState,
  VaultStatus,
  VersionContent
} from '../types/domain';

/** Every result crossing the bridge is wrapped so main-process errors never reject blindly. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export interface IpcError {
  code: string;
  message: string;
}

export interface DiffRequest {
  versionId: string;
  /** `previous` compares with the prior content version, `current` with the file on disk. */
  compareWith: 'previous' | 'current';
}

export interface TimelineRequest {
  fileId: string;
  limit?: number;
  offset?: number;
}

export interface ListFilesRequest {
  /** `deleted` powers the deleted-files view. */
  filter: 'all' | 'active' | 'deleted';
  query?: string;
  limit?: number;
  offset?: number;
}

export interface CommandMap {
  'vault:select': { request: void; response: VaultStatus };
  'vault:startTracking': { request: void; response: VaultStatus };
  'vault:pauseTracking': { request: void; response: VaultStatus };
  'vault:resumeTracking': { request: void; response: VaultStatus };
  'vault:rescan': { request: void; response: VaultStatus };
  'version:restore': { request: RestoreRequest; response: RestoreOutcome };
  'file:recoverDeleted': { request: RecoverRequest; response: RecoverOutcome };
  'settings:update': { request: Partial<AppSettings>; response: AppSettings };
  'search:rebuildIndex': { request: void; response: { indexedVersions: number } };
  /** Reveals the folders described in the settings panel (FR-11). */
  'app:openDataFolder': { request: void; response: null };
  'app:openLogsFolder': { request: void; response: null };
}

export interface QueryMap {
  'vault:status': { request: void; response: VaultStatus };
  'file:list': { request: ListFilesRequest; response: FileSummary[] };
  'file:get': { request: { fileId: string }; response: TrackedFile | null };
  'file:currentContent': { request: { fileId: string }; response: VersionContent | null };
  'timeline:get': { request: TimelineRequest; response: TimelineGroup[] };
  'version:content': { request: { versionId: string }; response: VersionContent | null };
  'version:diff': { request: DiffRequest; response: DiffResult };
  'search:versions': { request: SearchQuery; response: SearchResults };
  'storage:usage': { request: void; response: StorageUsage };
  'health:status': { request: void; response: HealthStatus };
  'health:skippedFiles': { request: void; response: SkippedFileReport[] };
  'settings:get': { request: void; response: AppSettings };
}

export type CommandName = keyof CommandMap;
export type QueryName = keyof QueryMap;
export type ChannelName = CommandName | QueryName;

/** Main → renderer push events (§16). */
export interface EventMap {
  indexProgress: IndexProgress;
  versionCaptured: { fileId: string; versionId: string; path: string };
  fileStateChanged: { fileId: string; status: TrackedFile['status']; path: string };
  trackingStateChanged: { state: TrackingState };
  healthChanged: HealthStatus;
  storageUsageChanged: StorageUsage;
  /** A capture is queued but not yet stored — the timeline shows "Recording change…". */
  capturePending: { path: string; pending: number };
}

export type EventName = keyof EventMap;

export const COMMAND_NAMES: readonly CommandName[] = [
  'vault:select',
  'vault:startTracking',
  'vault:pauseTracking',
  'vault:resumeTracking',
  'vault:rescan',
  'version:restore',
  'file:recoverDeleted',
  'settings:update',
  'search:rebuildIndex',
  'app:openDataFolder',
  'app:openLogsFolder'
];

export const QUERY_NAMES: readonly QueryName[] = [
  'vault:status',
  'file:list',
  'file:get',
  'file:currentContent',
  'timeline:get',
  'version:content',
  'version:diff',
  'search:versions',
  'storage:usage',
  'health:status',
  'health:skippedFiles',
  'settings:get'
];

export const EVENT_NAMES: readonly EventName[] = [
  'indexProgress',
  'versionCaptured',
  'fileStateChanged',
  'trackingStateChanged',
  'healthChanged',
  'storageUsageChanged',
  'capturePending'
];

/**
 * The surface exposed on `window.recover` by the preload bridge.
 *
 * Intentionally untyped in its payloads: the preload script is a plain forwarder, and the
 * channel-to-payload typing lives in the renderer client (`renderer/lib/ipc.ts`), which is
 * where a mismatch is worth catching.
 */
export interface RecoverBridge {
  invoke(channel: string, payload?: unknown): Promise<IpcResult<unknown>>;
  on(event: string, listener: (payload: unknown) => void): () => void;
}
