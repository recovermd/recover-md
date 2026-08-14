import { describe, expect, it } from 'vitest';
import { TRACKING_STATUS_LABEL, trackingStatusLabel } from '../../src/shared/copy';

describe('trackingStatusLabel', () => {
  it('names the watching count while active', () => {
    expect(trackingStatusLabel('active', 0)).toBe('Watching 0 files');
    expect(trackingStatusLabel('active', 1)).toBe('Watching 1 file');
    expect(trackingStatusLabel('active', 42)).toBe('Watching 42 files');
  });

  it('uses the static labels for every other state', () => {
    expect(trackingStatusLabel('paused')).toBe(TRACKING_STATUS_LABEL.paused);
    expect(trackingStatusLabel('stopped')).toBe(TRACKING_STATUS_LABEL.stopped);
  });
});
