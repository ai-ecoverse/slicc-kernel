import {
  WASM_DEFAULT_THREADS,
  WASM_MAX_THREADS,
  WASM_THREAD_EXIT,
  WASM_THREAD_SPAWN,
} from '../../kernel/protocol.ts';
import type { SabPostLike } from '../../realm/sync-sab-bridge.ts';
import { anyBlocked, type BlockedMask } from '../../realm/sync-sab-wire.ts';
import { SHARED_IDS_BYTES } from './wasi-files.ts';

const LAST_TID = 0;
const RUNNING = 1;

export const MAIN_TID = 1;

export class ThreadExit extends Error {
  constructor() {
    super('thread exit');
  }
}

export function threadCap(env: Readonly<Record<string, string>>): number {
  const asked = Number.parseInt(env.SLICC_WASM_THREADS ?? '', 10);
  return asked >= 1 ? Math.min(asked, WASM_MAX_THREADS) : WASM_DEFAULT_THREADS;
}

export class WasiThreads {
  readonly ids: Int32Array;

  beforeSpawn: (() => void) | undefined;

  modules: (() => Record<string, WebAssembly.Module>) | undefined;

  received: Readonly<Record<string, WebAssembly.Module>> | undefined;

  blocked: (() => BlockedMask) | undefined;

  private readonly port: SabPostLike;
  private readonly memory: WebAssembly.Memory;
  private readonly cap: number;
  readonly tid: number;
  constructor(
    port: SabPostLike,
    memory: WebAssembly.Memory,
    cap: number,

    tid: number,
    ids?: SharedArrayBuffer
  ) {
    this.port = port;
    this.memory = memory;
    this.cap = cap;
    this.tid = tid;
    this.ids = new Int32Array(ids ?? new SharedArrayBuffer(SHARED_IDS_BYTES));
    if (!ids) Atomics.store(this.ids, LAST_TID, MAIN_TID);
  }

  spawn(arg: number): number {
    if (Atomics.add(this.ids, RUNNING, 1) + 1 >= this.cap) {
      Atomics.sub(this.ids, RUNNING, 1);
      return -1;
    }
    this.beforeSpawn?.();
    const tid = Atomics.add(this.ids, LAST_TID, 1) + 1;
    const modules = this.modules?.();
    const blocked = this.blocked?.();
    this.port.postMessage({
      type: WASM_THREAD_SPAWN,
      thread: {
        tid,
        arg,
        memory: this.memory,
        ids: this.ids.buffer as SharedArrayBuffer,
        ...(modules ? { modules } : {}),
        ...(anyBlocked(blocked) ? { blocked } : {}),
      },
    });
    return tid;
  }

  exited(): void {
    Atomics.sub(this.ids, RUNNING, 1);
    this.port.postMessage({ type: WASM_THREAD_EXIT });
  }

  known(tid: number): boolean {
    return tid >= MAIN_TID && tid <= Atomics.load(this.ids, LAST_TID);
  }

  parallelism(): number {
    const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency;
    return Math.max(1, Math.min(this.cap, cores ?? this.cap));
  }
}
