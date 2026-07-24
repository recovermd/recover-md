/**
 * Preload bridge (§20).
 *
 * The entire renderer capability surface is these two functions. No Node primitives, no
 * `ipcRenderer` object, no filesystem — just a validated request/response channel and a
 * subscription for main-process events.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_NAMES, type EventMap, type EventName } from '@shared/contracts/ipc';

const INVOKE_CHANNEL = 'recover:invoke';
const EVENT_CHANNEL = 'recover:event';

const bridge = {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    return ipcRenderer.invoke(INVOKE_CHANNEL, channel, payload ?? null);
  },
  on(event: string, listener: (payload: unknown) => void): () => void {
    if (!EVENT_NAMES.includes(event as EventName)) {
      throw new Error(`Unknown event: ${event}`);
    }
    const wrapped = (
      _electronEvent: unknown,
      message: { name: EventName; payload: EventMap[EventName] }
    ): void => {
      if (message?.name === event) listener(message.payload);
    };
    ipcRenderer.on(EVENT_CHANNEL, wrapped);
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, wrapped);
    };
  }
};

contextBridge.exposeInMainWorld('recover', bridge);
