export const SNAPSHOT_TTL_MS = 60_000;

export interface ForkSnapshotRef {
  token: string;
  total: number;
}

export interface ForkSnapshots {
  keep(bytes: Uint8Array): ForkSnapshotRef;
  take(token: string): Uint8Array | undefined;
  read(token: string, offset: number, max: number): Uint8Array | undefined;
  release(token: string): void;
  readonly size: number;
}

interface Held {
  bytes: Uint8Array;
  timer: ReturnType<typeof setTimeout>;
}

export function forkSnapshots(ttlMs = SNAPSHOT_TTL_MS): ForkSnapshots {
  const held = new Map<string, Held>();
  const release = (token: string): void => {
    const entry = held.get(token);
    if (!entry) return;
    clearTimeout(entry.timer);
    held.delete(token);
  };
  return {
    keep(bytes) {
      const token = crypto.randomUUID();
      held.set(token, { bytes, timer: setTimeout(() => held.delete(token), ttlMs) });
      return { token, total: bytes.byteLength };
    },
    take(token) {
      const entry = held.get(token);
      release(token);
      return entry?.bytes;
    },
    read(token, offset, max) {
      const entry = held.get(token);
      if (!entry || !Number.isInteger(offset) || offset < 0) return undefined;
      const end = Math.min(entry.bytes.byteLength, offset + max);
      const bytes = entry.bytes.slice(offset, end);
      if (end >= entry.bytes.byteLength) release(token);
      return bytes;
    },
    release,
    get size() {
      return held.size;
    },
  };
}
