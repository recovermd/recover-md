/**
 * Core domain vocabulary shared by the main process, preload bridge and renderer.
 *
 * These types describe *what* Recover.MD stores and reports. They must stay free of
 * Electron, Node and React imports so they can be used from every layer and from tests.
 */

/** Lifecycle of vault tracking, surfaced verbatim in the UI (FR-1). */
export type TrackingState =
  | 'starting'
  | 'indexing'
  | 'active'
  | 'paused'
  | 'degraded'
  | 'unavailable'
  | 'stopped';

/** How a version came to be captured (FR-4, "capture origins"). */
export type CaptureOrigin =
  | 'initial_scan'
  | 'watcher'
  | 'startup_reconciliation'
  | 'periodic_reconciliation'
  | 'restore'
  | 'recovery';

/** What happened to the file at capture time (FR-4, "event types"). */
export type VersionEventType =
  | 'baseline'
  | 'create'
  | 'modify'
  | 'rename'
  | 'delete'
  | 'restore'
  | 'recover';

/** Tracked-file state. `unavailable` means the vault or path could not be read. */
export type FileStatus = 'active' | 'deleted' | 'unavailable';

/** Compression codec used for a stored blob. Only `brotli` exists in v0.1. */
export type BlobCodec = 'brotli' | 'identity';

export interface VaultRecord {
  id: string;
  rootPath: string;
  canonicalRootPath: string;
  createdAt: number;
  updatedAt: number;
  lastScanAt: number | null;
  trackingState: TrackingState;
}

export interface TrackedFile {
  id: string;
  vaultId: string;
  currentPath: string;
  normalizedPath: string;
  status: FileStatus;
  currentVersionId: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | null;
}

export interface VersionRecord {
  id: string;
  fileId: string;
  sequence: number;
  eventType: VersionEventType;
  /** Vault-relative path the file had when this version was captured. */
  path: string;
  capturedAt: number;
  sourceMtimeMs: number | null;
  blobHash: string | null;
  byteSize: number;
  lineCount: number | null;
  addedLines: number | null;
  removedLines: number | null;
  previousVersionId: string | null;
  origin: CaptureOrigin;
  label: string | null;
  /** Free-form JSON metadata; reserved for future integrations. */
  metadata: Record<string, unknown>;
}

/** A version enriched with presentation-only fields for the timeline. */
export interface TimelineEntry extends VersionRecord {
  isCurrent: boolean;
  /** Set when this version's path differs from the file's current path. */
  previousPath: string | null;
  /** True when the stored bytes cannot be decoded as UTF-8 text. */
  textUnsupported: boolean;
}

export type TimelineGroupKey = 'current' | 'today' | 'yesterday' | 'this_week' | 'older';

export interface TimelineGroup {
  key: TimelineGroupKey;
  entries: TimelineEntry[];
}

export interface FileSummary {
  id: string;
  currentPath: string;
  normalizedPath: string;
  status: FileStatus;
  versionCount: number;
  lastCapturedAt: number | null;
  byteSize: number;
}

export interface VersionContent {
  versionId: string;
  /** Base64 of the exact stored bytes. Base64 keeps the IPC payload byte-exact. */
  contentBase64: string;
  /** Decoded text, or null when the bytes are not valid UTF-8. */
  text: string | null;
  byteSize: number;
  hash: string | null;
  encodingSupported: boolean;
  /** True when the file has a UTF-8 byte-order mark. */
  hasBom: boolean;
}

export type DiffLineType = 'context' | 'added' | 'removed';

export interface DiffLine {
  type: DiffLineType;
  /** 1-based line number in the left/old document, null for added lines. */
  oldLine: number | null;
  /** 1-based line number in the right/new document, null for removed lines. */
  newLine: number | null;
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  addedLines: number;
  removedLines: number;
  /** True when the diff was degraded because the inputs exceeded the work budget. */
  truncated: boolean;
  /** True when either side could not be decoded as text. */
  unsupported: boolean;
}

export type SearchScope = 'all' | 'current' | 'historical' | 'deleted';

export interface SearchQuery {
  text: string;
  scope: SearchScope;
  fromDate?: number | null;
  toDate?: number | null;
  limit?: number;
  offset?: number;
}

export interface SearchMatch {
  versionId: string;
  fileId: string;
  filename: string;
  path: string;
  snippet: string;
  capturedAt: number;
  eventType: VersionEventType;
  isCurrent: boolean;
  fileStatus: FileStatus;
}

export interface SearchResultGroup {
  fileId: string;
  currentPath: string;
  fileStatus: FileStatus;
  matches: SearchMatch[];
}

export interface SearchResults {
  groups: SearchResultGroup[];
  totalMatches: number;
  hasMore: boolean;
}

export type HealthSeverity = 'info' | 'warning' | 'error';

export type HealthIssueCode =
  | 'tracking_stopped'
  | 'tracking_paused'
  | 'vault_unavailable'
  | 'database_unavailable'
  | 'database_safe_mode'
  | 'disk_space_low'
  | 'file_unreadable'
  | 'file_too_large'
  | 'search_index_stale'
  | 'watcher_restarting'
  | 'capture_failed';

export interface HealthIssue {
  code: HealthIssueCode;
  severity: HealthSeverity;
  message: string;
  detail?: string;
  since: number;
  /** Paths involved, when the issue is file-specific. */
  paths?: string[];
}

export interface HealthStatus {
  issues: HealthIssue[];
  /** Convenience flag: true when no error-severity issue is present. */
  healthy: boolean;
}

export interface IndexProgress {
  phase: 'scanning' | 'capturing' | 'done';
  processed: number;
  total: number;
  currentPath: string | null;
}

export interface StorageUsage {
  databaseBytes: number;
  blobCount: number;
  blobRawBytes: number;
  blobCompressedBytes: number;
  versionCount: number;
  fileCount: number;
  backupBytes: number;
}

export interface AppSettings {
  /** Debounce before a stable state is captured, in milliseconds (1s–30s). */
  snapshotDelayMs: number;
  /** Extra ignore patterns supplied by the user, one glob-ish pattern per entry. */
  ignorePatterns: string[];
  launchAtLogin: boolean;
  theme: 'system' | 'light' | 'dark';
}

export interface VaultStatus {
  vault: VaultRecord | null;
  trackingState: TrackingState;
  indexProgress: IndexProgress | null;
  /** True when the database is open in read-only safe mode after an integrity failure. */
  safeMode: boolean;
  pendingCaptures: number;
  /** Active (not deleted) Markdown files currently tracked in this vault. */
  activeFileCount: number;
}

export interface RestoreRequest {
  versionId: string;
  /**
   * Hash of the current on-disk content as it was when the restore dialog opened.
   * Null means "the file did not exist". Used for conflict detection (FR-7).
   */
  expectedCurrentHash: string | null;
  /** Set by the renderer only after the user re-confirms a detected conflict. */
  force?: boolean;
}

export type RestoreOutcome =
  | { status: 'restored'; versionId: string; path: string }
  | { status: 'noop'; reason: 'identical'; path: string }
  | { status: 'conflict'; currentHash: string | null; path: string }
  | { status: 'failed'; reason: string; path: string };

export interface RecoverRequest {
  versionId: string;
  /** How to behave when the destination path is occupied. */
  onConflict: 'fail' | 'rename' | 'replace';
  /** Allow re-creating a missing parent directory. */
  createParentDirectories: boolean;
}

export type RecoverOutcome =
  | { status: 'recovered'; path: string }
  | { status: 'path_occupied'; path: string; suggestedPath: string }
  | { status: 'missing_parent'; path: string }
  | { status: 'failed'; reason: string; path: string };

export interface SkippedFileReport {
  path: string;
  reason: 'too_large' | 'unreadable' | 'not_a_file';
  detail: string;
  byteSize: number | null;
  at: number;
}
