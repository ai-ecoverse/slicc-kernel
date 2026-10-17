const GEN = 0;
const RING = 1;
const RING_SIZE = 4096;
const SLOT = 2;

const DIRTY = RING + RING_SIZE * SLOT;
const FOREIGN = DIRTY + 1;

export const CHANGES_BYTES = (FOREIGN + 1) * 4;

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

  dirtied(delta: number): void {
    Atomics.add(this.view, DIRTY, delta);
  }

  foreign(on: boolean): void {
    Atomics.store(this.view, FOREIGN, on ? 1 : 0);
  }

  publish(...paths: string[]): void {
    for (const path of paths) {
      const g = (Atomics.add(this.view, GEN, 1) + 1) | 0;
      const at = RING + (g & (RING_SIZE - 1)) * SLOT;
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

  clean(): boolean {
    return this.view.length > DIRTY && Atomics.load(this.view, DIRTY) === 0;
  }

  foreign(): boolean {
    return this.view.length > FOREIGN && Atomics.load(this.view, FOREIGN) === 1;
  }

  changedSince(seen: number, path: string): { now: number; changed: boolean } {
    const now = Atomics.load(this.view, GEN);
    const distance = (now - seen) >>> 0;
    if (distance === 0) return { now, changed: false };
    if (distance > RING_SIZE) return { now, changed: true };
    const hash = changeHash(normal(path));
    for (let i = 1; i <= distance; i++) {
      const g = (seen + i) | 0;
      const at = RING + (g & (RING_SIZE - 1)) * SLOT;
      if (Atomics.load(this.view, at) !== g) return { now, changed: true };
      const hit = Atomics.load(this.view, at + 1) === hash;
      if (Atomics.load(this.view, at) !== g) return { now, changed: true };
      if (hit) return { now, changed: true };
    }
    return { now, changed: false };
  }
}
