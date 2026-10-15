const GEN = 0;
const RING = 1;
const RING_SIZE = 4096;
const SLOT = 2;

export const CHANGES_BYTES = (RING + RING_SIZE * SLOT) * 4;

export function changeHash(path: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h === 0 ? 1 : h;
}

function normal(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export class FileChanges {
  readonly sab: SharedArrayBuffer;
  private readonly view: Int32Array;

  constructor(sab: SharedArrayBuffer = new SharedArrayBuffer(CHANGES_BYTES)) {
    this.sab = sab;
    this.view = new Int32Array(sab);
  }

  publish(...paths: string[]): void {
    for (const path of paths) {
      const g = Atomics.add(this.view, GEN, 1) + 1;
      const at = RING + (g % RING_SIZE) * SLOT;
      Atomics.store(this.view, at, 0);
      Atomics.store(this.view, at + 1, changeHash(normal(path)));
      Atomics.store(this.view, at, g);
    }
  }
}

export class ChangeView {
  private readonly view: Int32Array;

  constructor(sab: SharedArrayBuffer) {
    this.view = new Int32Array(sab);
  }

  now(): number {
    return Atomics.load(this.view, GEN);
  }

  changedSince(seen: number, path: string): { now: number; changed: boolean } {
    const now = Atomics.load(this.view, GEN);
    if (now === seen) return { now, changed: false };
    if (now - seen > RING_SIZE) return { now, changed: true };
    const hash = changeHash(normal(path));
    for (let g = seen + 1; g <= now; g++) {
      const at = RING + (g % RING_SIZE) * SLOT;
      const tag = Atomics.load(this.view, at);
      if (tag !== g) return { now, changed: true };
      const hit = Atomics.load(this.view, at + 1) === hash;
      if (Atomics.load(this.view, at) !== g) return { now, changed: true };
      if (hit) return { now, changed: true };
    }
    return { now, changed: false };
  }
}
