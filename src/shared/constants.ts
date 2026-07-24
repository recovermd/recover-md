/** Product-wide constants derived directly from the PRD. */

/** FR-2: MVP supports Markdown files up to 10 MB. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** FR-3: default debounce before a state is considered stable. */
export const DEFAULT_SNAPSHOT_DELAY_MS = 2_000;
export const MIN_SNAPSHOT_DELAY_MS = 1_000;
export const MAX_SNAPSHOT_DELAY_MS = 30_000;

/** FR-3: capture at least once per minute during continuous editing. */
export const MAX_CONTINUOUS_EDIT_INTERVAL_MS = 60_000;

/** FR-3: a delete stays pending this long so atomic saves are not seen as deletions. */
export const DELETE_GRACE_MS = 2_000;

/** FR-3: window in which a delete + create pair may be correlated into a rename. */
export const RENAME_CORRELATION_WINDOW_MS = 2_000;

/** FR-3: periodic reconciliation cadence while the app runs. */
export const PERIODIC_RECONCILE_INTERVAL_MS = 5 * 60_000;

/** Bounded concurrency for capture work across distinct files. */
export const CAPTURE_CONCURRENCY = 4;

/** Supported Markdown extension (FR-2). */
export const MARKDOWN_EXTENSION = '.md';

/** FR-12: warn below this much free disk space. */
export const LOW_DISK_SPACE_BYTES = 512 * 1024 * 1024;

/** Diff work budget; beyond this the diff degrades to a whole-block replacement. */
export const DIFF_MAX_EDIT_LENGTH = 20_000;

/** Default page size for search results. */
export const SEARCH_PAGE_SIZE = 25;

/** Reliability: number of database backups retained (§19.1). */
export const BACKUP_RETENTION = 3;

export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  '.git/**',
  'node_modules/**',
  '.obsidian/cache/**',
  '.trash/**',
  'trash/**',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/desktop.ini',
  '**/*.tmp',
  '**/*.temp',
  '**/*.swp',
  '**/*.swx',
  '**/*~',
  '**/.#*',
  '**/~$*'
];
