import type { SyncFsResult } from '../../realm/sync-fs-wire.ts';
import type { SyncSabRequestBody } from '../../realm/sync-sab-wire.ts';
import { MAX_IO, written } from './js-io.ts';
import type { SyncCall } from './js-sync.ts';

export interface PendingWrite {
  fd: number;
  data: Uint8Array;
  at: number;
  len: number;
  op?: number;
}

export interface SavedMode {
  fd: number;
  termios: unknown;
}

function writeOut(lane: SyncCall, fd: number, data: Uint8Array): boolean {
  let at = 0;
  while (at < data.length) {
    const body = data.subarray(at, at + MAX_IO);
    const r = lane({ op: 'fd-write', fd, body });
    if (!r.ok && r.errno === 'EINTR') continue;
    if (!r.ok) return false;
    const n = written(r, body.length);
    if (n <= 0) return false;
    at += n;
  }
  return true;
}

function progress(result: SyncFsResult | null | undefined, len: number): number {
  if (!result) return len;
  if (result.ok) return written(result, len);
  return result.errno === 'EINTR' ? 0 : -1;
}

function settled(lane: SyncCall, writes: readonly PendingWrite[]): Map<PendingWrite, number> {
  const inFlight = writes.filter((w) => w.op !== undefined);
  const out = new Map<PendingWrite, number>();
  if (inFlight.length === 0) return out;
  const r = lane({ op: 'async-settle', ids: inFlight.map((w) => w.op as number) });
  const results = (r.ok && r.kind === 'json' ? r.json : []) as Array<SyncFsResult | null>;
  inFlight.forEach((w, i) => {
    const result = results[i];
    out.set(w, progress(result, w.len));
  });
  return out;
}

export function exitAtOnce(
  lane: SyncCall,
  writes: readonly PendingWrite[],
  modes: readonly SavedMode[],
  status: number
): never {
  const done = settled(lane, writes);
  const broken = new Set<number>();
  for (const w of writes) {
    const sent = done.get(w);
    if (sent === -1) broken.add(w.fd);
    if (broken.has(w.fd)) continue;
    if (!writeOut(lane, w.fd, w.data.subarray(w.at + (sent ?? 0)))) broken.add(w.fd);
  }
  for (const { fd, termios } of modes) lane({ op: 'tty-set', fd, termios } as SyncSabRequestBody);
  lane({ op: 'proc-exit', status: status & 0xff });
  const parked = new Int32Array(new SharedArrayBuffer(4));
  for (;;) Atomics.wait(parked, 0, 0);
}
