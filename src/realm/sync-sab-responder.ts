import type { WasmSyscall } from '../kernel/process.ts';
import {
  SYNC_FS_REQUEST_TIMEOUT_MS,
  type SyncFsRequest,
  type SyncFsResult,
} from './sync-fs-wire.ts';
import {
  encodeSabResult,
  SAB_I_CHUNK,
  SAB_I_OFFSET,
  SAB_I_OFFSET_HI,
  SAB_I_PUB,
  SAB_I_REQ,
  SAB_I_SEQ,
  SAB_I_STATE,
  SAB_I_STATUS,
  SAB_I_TOTAL,
  SAB_I_TOTAL_HI,
  SAB_STATE_READY,
  type SabViews,
  SYNC_SAB_NEXT_MSG,
  SYNC_SAB_REQ_MSG,
  type SyncSabNextMsg,
  type SyncSabReqMsg,
  sabViews,
  storeU53,
} from './sync-sab-wire.ts';

export interface SabPortLike {
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
}

export interface SyncSabResponderHandle {
  dispose(): void;
}

interface PendingPayload {
  status: number;
  payload: Uint8Array;
  timer: ReturnType<typeof setTimeout>;
}

const PENDING_TTL_MS = SYNC_FS_REQUEST_TIMEOUT_MS + 5_000;

export type SyncSabDispatchRequest = SyncFsRequest | (WasmSyscall & { token: string });

export interface SyncSabResponderOptions {
  dispatch: (req: SyncSabDispatchRequest) => Promise<SyncFsResult>;
}

export function attachSyncSabResponder(
  port: SabPortLike,
  sab: SharedArrayBuffer,
  token: string,
  opts: SyncSabResponderOptions
): SyncSabResponderHandle {
  const views: SabViews = sabViews(sab);
  const { header, window } = views;
  const pending = new Map<number, PendingPayload>();
  let disposed = false;

  const { dispatch } = opts;

  function drop(id: number): void {
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
  }

  function publish(id: number, entry: PendingPayload, offset: number): void {
    if (Atomics.load(header, SAB_I_REQ) !== id) {
      drop(id);
      return;
    }
    const chunk = Math.min(window.byteLength, entry.payload.byteLength - offset);
    if (chunk > 0) window.set(entry.payload.subarray(offset, offset + chunk));
    Atomics.store(header, SAB_I_STATUS, entry.status);
    storeU53(header, SAB_I_TOTAL, SAB_I_TOTAL_HI, entry.payload.byteLength);
    Atomics.store(header, SAB_I_CHUNK, chunk);
    storeU53(header, SAB_I_OFFSET, SAB_I_OFFSET_HI, offset);
    Atomics.store(header, SAB_I_SEQ, id);
    Atomics.store(header, SAB_I_STATE, SAB_STATE_READY);
    Atomics.add(header, SAB_I_PUB, 1);
    Atomics.notify(header, SAB_I_PUB);

    if (offset + chunk >= entry.payload.byteLength) drop(id);
  }

  function settle(id: number, result: SyncFsResult): void {
    if (disposed) return;
    const { status, payload } = encodeSabResult(result);

    drop(id);
    const entry: PendingPayload = {
      status,
      payload,
      timer: setTimeout(() => drop(id), PENDING_TTL_MS),
    };
    pending.set(id, entry);
    publish(id, entry, 0);
  }

  const handler = (event: MessageEvent): void => {
    const data = event.data as
      | { type?: unknown; id?: unknown; req?: unknown; offset?: unknown }
      | undefined;
    if (!data || typeof data.id !== 'number') return;
    if (data.type === SYNC_SAB_NEXT_MSG) {
      const entry = pending.get(data.id);
      const offset = (data as Partial<SyncSabNextMsg>).offset;
      if (
        !entry ||
        typeof offset !== 'number' ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > entry.payload.byteLength
      ) {
        settle(data.id, { ok: false, errno: 'EIO', message: 'sync-sab: bad continuation' });
        return;
      }
      publish(data.id, entry, offset);
      return;
    }
    if (data.type !== SYNC_SAB_REQ_MSG || !data.req || typeof data.req !== 'object') return;
    const id = data.id;

    const body = (data as SyncSabReqMsg).req;
    const req = { ...body, token } as SyncSabDispatchRequest;
    let dispatched: Promise<SyncFsResult>;
    try {
      dispatched = dispatch(req);
    } catch (err) {
      settle(id, {
        ok: false,
        errno: 'EIO',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    void dispatched.then(
      (result) => settle(id, result),
      (err) =>
        settle(id, {
          ok: false,
          errno: 'EIO',
          message: err instanceof Error ? err.message : String(err),
        })
    );
  };

  port.addEventListener('message', handler);
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      port.removeEventListener('message', handler);
      for (const id of [...pending.keys()]) drop(id);
    },
  };
}
