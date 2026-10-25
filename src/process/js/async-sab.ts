import type { SyncFsResult } from '../../realm/sync-fs-wire.ts';
import { exactBody, type SabPostLike } from '../../realm/sync-sab-bridge.ts';
import {
  copyWindow,
  decodeSabResult,
  loadU53,
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
  SAB_STATE_IDLE,
  SAB_STATE_PENDING,
  SAB_STATE_READY,
  SYNC_SAB_NEXT_MSG,
  SYNC_SAB_REQ_MSG,
  type SyncSabRequestBody,
  sabLoad,
  sabStore,
  sabViews,
  sabWaitAsync,
} from '../../realm/sync-sab-wire.ts';

export type WaitAsyncLike = (
  typedArray: Int32Array,
  index: number,
  value: number
) => { async: false; value: string } | { async: true; value: Promise<string> };

export interface AsyncSabTransport {
  call(req: SyncSabRequestBody): Promise<SyncFsResult>;
}

const defaultWaitAsync: WaitAsyncLike = (a, i, v) => (sabWaitAsync as WaitAsyncLike)(a, i, v);

export async function changed(
  header: Int32Array,
  index: number,
  seen: number,
  waitAsync: WaitAsyncLike = defaultWaitAsync
): Promise<void> {
  const waited = waitAsync(header, index, seen);
  if (waited.async) await waited.value;
}

export function createAsyncSabTransport(
  sab: SharedArrayBuffer,
  port: SabPostLike,
  waitAsync: WaitAsyncLike = defaultWaitAsync
): AsyncSabTransport {
  const { header, window } = sabViews(sab);
  let seq = 0;
  let tail: Promise<unknown> = Promise.resolve();

  async function ready(id: number): Promise<void> {
    for (;;) {
      const published = sabLoad(header, SAB_I_PUB);
      if (sabLoad(header, SAB_I_STATE) === SAB_STATE_READY && sabLoad(header, SAB_I_SEQ) === id) {
        return;
      }
      await changed(header, SAB_I_PUB, published, waitAsync);
    }
  }

  async function once(asked: SyncSabRequestBody): Promise<SyncFsResult> {
    const { req, transfer } = exactBody(asked);
    const id = ++seq;
    let out: Uint8Array | null = null;
    let status = 0;
    let offset = 0;
    sabStore(header, SAB_I_REQ, id);
    try {
      for (;;) {
        sabStore(header, SAB_I_STATE, SAB_STATE_PENDING);
        if (offset === 0) port.postMessage({ type: SYNC_SAB_REQ_MSG, id, req }, transfer);
        else port.postMessage({ type: SYNC_SAB_NEXT_MSG, id, offset });
        await ready(id);
        const total = loadU53(header, SAB_I_TOTAL, SAB_I_TOTAL_HI);
        const chunk = sabLoad(header, SAB_I_CHUNK);
        const at = loadU53(header, SAB_I_OFFSET, SAB_I_OFFSET_HI);
        if (at !== offset || chunk < 0 || total < 0 || offset + chunk > total) {
          return { ok: false, errno: 'EIO', message: 'sync-sab: torn reply' };
        }
        if (out === null) {
          status = sabLoad(header, SAB_I_STATUS);
          out = new Uint8Array(total);
        }
        copyWindow(out, window, chunk, offset);
        offset += chunk;
        if (offset >= total) break;
        if (chunk === 0) return { ok: false, errno: 'EIO', message: 'sync-sab: empty chunk' };
      }
    } finally {
      sabStore(header, SAB_I_REQ, 0);
      sabStore(header, SAB_I_STATE, SAB_STATE_IDLE);
    }
    return decodeSabResult(status, out);
  }

  return {
    call(req) {
      const run = tail.then(() => once(req));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
