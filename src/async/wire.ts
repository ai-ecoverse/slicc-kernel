import type {
  ForkState,
  HeldCwdInit,
  WasmProcessInitMsg,
  WasmProgram,
} from '../kernel/protocol.ts';
import type { SyncSabRequestBody } from '../realm/sync-sab-wire.ts';
import type { ForkSnapshotRef } from './snapshots.ts';

export const ASYNC_SYSCALL = 'async-syscall';
export const ASYNC_MORE = 'async-more';
export const ASYNC_STAGE = 'async-stage';
export const ASYNC_WORDS = 'async-words';
export const ASYNC_MIRROR = 'async-mirror';
export const ASYNC_SNAPSHOT = 'async-snapshot';
export const ASYNC_SNAPSHOT_TAKEN = 'async-snapshot-taken';

export interface AsyncSnapshotMsg {
  type: typeof ASYNC_SNAPSHOT;
  token: string;
  offset: number;
}

export interface AsyncSnapshotReply {
  bytes: Uint8Array;
}

export interface AsyncSnapshotTakenMsg {
  type: typeof ASYNC_SNAPSHOT_TAKEN;
  token: string;
}

export interface ProcessWords {
  n: number;
  seen: number;
  signals: number;
  timers: number;
  blocked: [number, number];
  memory: number;
  idle: number;
}

export interface MirrorUpdate {
  seq: number;
  signals: number;
  timers: number;
  killed: number;
  async: number;
  stop: number;
  clock: number;
  changes?: Int32Array;
  cwds?: Int32Array;
}

export interface MirroredBuffer {
  bytes: number;
  runs: Int32Array;
}

export interface InitMirror {
  seq: 0;
  header: Int32Array;
  clock: [number, number];
  changes?: MirroredBuffer;
  cwds?: MirroredBuffer;
}

export interface StagedBytes {
  part: number;
  total: number;
}

export type AsyncForkState = Omit<ForkState, 'memory'> & {
  memory: Uint8Array | StagedBytes;
  snapshot?: ForkSnapshotRef;
};

export type AsyncProgram = Omit<WasmProgram, 'module'> & { image: string };

export type AsyncProcessInit = Omit<
  WasmProcessInitMsg,
  'sab' | 'changes' | 'held' | 'program' | 'fork'
> & {
  program: AsyncProgram;
  held?: Omit<HeldCwdInit, 'sab'>;
  fork?: AsyncForkState;
  mirror: InitMirror;
  maxMessageBytes?: number;
};

export interface AsyncSyscallMsg {
  type: typeof ASYNC_SYSCALL;
  req: SyncSabRequestBody;
  words: ProcessWords;
  staged?: number;
}

export interface AsyncMoreMsg {
  type: typeof ASYNC_MORE;
  part: number;
  offset: number;
}

export interface AsyncStageMsg {
  type: typeof ASYNC_STAGE;
  stage: number;
  offset: number;
  total: number;
  bytes: Uint8Array;
}

export interface AsyncWordsMsg {
  type: typeof ASYNC_WORDS;
  words: ProcessWords;
}

export interface AsyncMirrorMsg {
  type: typeof ASYNC_MIRROR;
  mirror: MirrorUpdate;
}

export interface AsyncAnswer {
  status: number;
  bytes: Uint8Array;
  total: number;
  part?: number;
  mirror: MirrorUpdate;
}

export interface AsyncRefusal {
  failed: string;
}

export type AsyncSyscallReply = AsyncAnswer | AsyncRefusal;

export interface AsyncMoreReply {
  bytes: Uint8Array;
}

export function diffRuns(last: Int32Array, now: Int32Array): Int32Array | undefined {
  const out: number[] = [];
  const length = now.length;
  let i = 0;
  while (i < length) {
    if (now[i] === last[i]) {
      i++;
      continue;
    }
    const start = i;
    const at = out.length;
    out.push(start, 0);
    while (i < length) {
      const next = now[i] as number;
      if (next === last[i]) break;
      last[i] = next;
      out.push(next);
      i++;
    }
    out[at + 1] = i - start;
  }
  return out.length === 0 ? undefined : Int32Array.from(out);
}

export function applyRuns(view: Int32Array, runs: Int32Array | undefined): void {
  if (!runs) return;
  let at = 0;
  while (at + 1 < runs.length) {
    const start = runs[at] as number;
    const count = runs[at + 1] as number;
    at += 2;
    for (let k = 0; k < count && start + k < view.length; k++) {
      Atomics.store(view, start + k, runs[at + k] as number);
    }
    at += count;
  }
}
