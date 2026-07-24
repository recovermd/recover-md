/**
 * Worker thread for CPU-bound diff computation (§15).
 *
 * Keeping Myers off the main event loop is what lets the UI stay responsive while a large
 * diff is produced. The worker is stateless: it holds no database or filesystem handles.
 */
import { parentPort } from 'node:worker_threads';
import { computeLineDiff } from '../../main/diff/diffEngine';
import type { DiffResult } from '@shared/types/domain';

export interface DiffJobRequest {
  id: number;
  oldText: string | null;
  newText: string | null;
  maxEditLength?: number;
}

export type DiffJobResponse =
  | { id: number; ok: true; result: DiffResult }
  | { id: number; ok: false; error: string };

if (parentPort) {
  parentPort.on('message', (message: DiffJobRequest) => {
    try {
      const result = computeLineDiff(message.oldText, message.newText, {
        maxEditLength: message.maxEditLength
      });
      const response: DiffJobResponse = { id: message.id, ok: true, result };
      parentPort?.postMessage(response);
    } catch (error) {
      const response: DiffJobResponse = {
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
      parentPort?.postMessage(response);
    }
  });
}
