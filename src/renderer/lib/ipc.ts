/**
 * Typed renderer-side IPC client.
 *
 * Mirrors the contract in `@shared/contracts/ipc`; the untyped `window.recover` bridge is
 * confined to this file.
 */
import type {
  ChannelName,
  CommandMap,
  CommandName,
  EventMap,
  EventName,
  IpcResult,
  QueryMap,
  QueryName,
  RecoverBridge
} from '@shared/contracts/ipc';

declare global {
  interface Window {
    recover: RecoverBridge;
  }
}

export class IpcError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

type RequestOf<C extends ChannelName> = C extends CommandName
  ? CommandMap[C]['request']
  : C extends QueryName
    ? QueryMap[C]['request']
    : never;

type ResponseOf<C extends ChannelName> = C extends CommandName
  ? CommandMap[C]['response']
  : C extends QueryName
    ? QueryMap[C]['response']
    : never;

/** Invokes a main-process channel, unwrapping the result envelope. */
export async function call<C extends ChannelName>(
  channel: C,
  ...args: RequestOf<C> extends void | undefined ? [] : [RequestOf<C>]
): Promise<ResponseOf<C>> {
  const payload = (args.length > 0 ? args[0] : undefined) as RequestOf<C>;
  const result = (await window.recover.invoke(channel, payload)) as IpcResult<ResponseOf<C>>;
  if (!result.ok) throw new IpcError(result.error.code, result.error.message);
  return result.data;
}

export function subscribe<E extends EventName>(
  event: E,
  listener: (payload: EventMap[E]) => void
): () => void {
  return window.recover.on(event, (payload) => listener(payload as EventMap[E]));
}
