/**
 * Human-facing status copy shared by the window chrome and the tray.
 *
 * Keep this free of Electron/React so both processes can use the same words.
 */
import type { TrackingState } from './types/domain';

export const TRACKING_STATUS_LABEL: Record<TrackingState, string> = {
  starting: 'Starting…',
  indexing: 'Indexing…',
  active: 'Watching',
  paused: 'Paused — not recording',
  degraded: 'Watcher recovering',
  unavailable: 'Folder unavailable',
  stopped: 'Not protected'
};

export function trackingStatusLabel(state: TrackingState, activeFileCount?: number): string {
  if (state === 'active') {
    const count = activeFileCount ?? 0;
    return count === 1 ? 'Watching 1 file' : `Watching ${count} files`;
  }
  return TRACKING_STATUS_LABEL[state];
}
