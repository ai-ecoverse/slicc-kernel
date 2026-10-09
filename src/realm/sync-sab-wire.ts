import type { WasmSyscall } from '../kernel/process.ts';
import type { SyncFsRequest, SyncFsResult } from './sync-fs-wire.ts';

export const SAB_HEADER_I32 = 16;
export const SAB_HEADER_BYTES = SAB_HEADER_I32 * 4;

export const SAB_I_STATE = 0;
export const SAB_I_SEQ = 1;
export const SAB_I_STATUS = 2;
export const SAB_I_TOTAL = 3;
export const SAB_I_CHUNK = 4;
export const SAB_I_OFFSET = 5;
export const SAB_I_REQ = 6;
export const SAB_I_PUB = 7;

export const SAB_I_SIGNALS = 8;

export const SAB_I_TIMERS = 9;

export const SAB_I_MEMORY = 10;

export const SAB_I_TOTAL_HI = 11;

export const SAB_I_OFFSET_HI = 12;

export const SAB_I_KILLED = 13;

export const SAB_I_ASYNC = 14;

export const SAB_I_STOP = 14;

const U32 = 2 ** 32;

export function storeU53(header: Int32Array, lo: number, hi: number, value: number): void {
  Atomics.store(header, hi, Math.floor(value / U32));
  Atomics.store(header, lo, (value % U32) | 0);
}

export function loadU53(header: Int32Array, lo: number, hi: number): number {
  return (Atomics.load(header, lo) >>> 0) + Atomics.load(header, hi) * U32;
}

export function publishMemory(sab: SharedArrayBuffer, bytes: number): void {
  if (bytes > 0)
    Atomics.store(new Int32Array(sab, 0, SAB_HEADER_I32), SAB_I_MEMORY, Math.ceil(bytes / 65536));
}

export const SAB_STATE_IDLE = 0;
export const SAB_STATE_PENDING = 1;
export const SAB_STATE_READY = 2;

export const SAB_STATUS_BYTES = 1;
export const SAB_STATUS_JSON = 2;
export const SAB_STATUS_VOID = 3;
export const SAB_STATUS_ERRNO = 4;

export const SAB_DEFAULT_WINDOW_BYTES = 1024 * 1024;

export const SAB_MIN_BYTES = SAB_HEADER_BYTES + 4096;

export const SYNC_SAB_REQ_MSG = 'sync-sab-req';

export const SYNC_SAB_NEXT_MSG = 'sync-sab-next';

export type SyncSabRequestBody = Omit<SyncFsRequest, 'token'> | WasmSyscall;

export interface SyncSabReqMsg {
  type: typeof SYNC_SAB_REQ_MSG;
  id: number;
  req: SyncSabRequestBody;
}
export interface SyncSabNextMsg {
  type: typeof SYNC_SAB_NEXT_MSG;
  id: number;
  offset: number;
}

export interface SabEncodedResult {
  status: number;
  payload: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeSabResult(result: SyncFsResult): SabEncodedResult {
  if (!result.ok) {
    return {
      status: SAB_STATUS_ERRNO,
      payload: encoder.encode(JSON.stringify({ errno: result.errno, message: result.message })),
    };
  }
  switch (result.kind) {
    case 'bytes':
      return { status: SAB_STATUS_BYTES, payload: result.bytes };
    case 'json':
      return { status: SAB_STATUS_JSON, payload: encoder.encode(JSON.stringify(result.json)) };
    default:
      return { status: SAB_STATUS_VOID, payload: new Uint8Array(0) };
  }
}

export function decodeSabResult(status: number, payload: Uint8Array): SyncFsResult {
  switch (status) {
    case SAB_STATUS_BYTES:
      return { ok: true, kind: 'bytes', bytes: payload };
    case SAB_STATUS_VOID:
      return { ok: true, kind: 'void' };
    case SAB_STATUS_JSON: {
      try {
        return { ok: true, kind: 'json', json: JSON.parse(decoder.decode(payload)) };
      } catch {
        return { ok: false, errno: 'EIO', message: 'sync-sab: malformed json payload' };
      }
    }
    case SAB_STATUS_ERRNO: {
      try {
        const parsed = JSON.parse(decoder.decode(payload)) as {
          errno?: unknown;
          message?: unknown;
        };
        const errno =
          typeof parsed.errno === 'string' && /^E[A-Z]+$/.test(parsed.errno) ? parsed.errno : 'EIO';
        return { ok: false, errno, message: String(parsed.message ?? errno) };
      } catch {
        return { ok: false, errno: 'EIO', message: 'sync-sab: malformed errno payload' };
      }
    }
    default:
      return { ok: false, errno: 'EIO', message: `sync-sab: unknown status ${status}` };
  }
}

export interface SabViews {
  header: Int32Array;
  window: Uint8Array;
}

export function sabViews(sab: SharedArrayBuffer): SabViews {
  if (sab.byteLength < SAB_MIN_BYTES) {
    throw new Error(`sync-sab: buffer too small (${sab.byteLength} < ${SAB_MIN_BYTES})`);
  }
  return {
    header: new Int32Array(sab, 0, SAB_HEADER_I32),
    window: new Uint8Array(sab, SAB_HEADER_BYTES),
  };
}
