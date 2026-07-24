/** Presentation helpers. All dates use the user's system locale and timezone (FR-5). */
import type { VersionEventType } from '@shared/types/domain';

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

/** Full timestamp for tooltips and version details (FR-5). */
export function formatAbsolute(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'full',
    timeStyle: 'medium'
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}

/**
 * Event labels (§2). Deliberately descriptive rather than attributive: Recover.MD does not
 * claim to know which application or agent made a change.
 */
export function eventLabel(event: VersionEventType, addedLines: number | null): string {
  switch (event) {
    case 'baseline':
      return 'Baseline';
    case 'create':
      return 'Created';
    case 'modify':
      return addedLines !== null && addedLines > 200 ? 'Large edit' : 'Edited';
    case 'rename':
      return 'Renamed';
    case 'delete':
      return 'Deleted';
    case 'restore':
      return 'Restored';
    case 'recover':
      return 'Recovered';
    default:
      return 'Changed';
  }
}

export const GROUP_LABELS: Record<string, string> = {
  current: 'Current',
  today: 'Today',
  yesterday: 'Yesterday',
  this_week: 'This week',
  older: 'Older'
};

export function fileName(displayPath: string): string {
  const parts = displayPath.split('/');
  return parts[parts.length - 1] ?? displayPath;
}

export function parentPath(displayPath: string): string {
  const parts = displayPath.split('/');
  parts.pop();
  return parts.join('/');
}
