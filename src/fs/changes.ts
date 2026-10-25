const GEN = 0;
const RING = 1;
const RING_SIZE = 4096;
const SLOT = 2;
export const SHARED_TTL_MS = 100;
export const RENAME_WAIT_MS = 100;

const DIRTY = RING + RING_SIZE * SLOT;
const FOREIGN = DIRTY + 1;
const RENAMES = FOREIGN + 1;
const HELD = RENAMES + 1;
const HELD_SLOTS = 1024;

export const CHANGES_BYTES = (HELD + HELD_SLOTS) * 4;

function heldSlot(path: string): number {
  return HELD + (changeHash(normal(path)) & (HELD_SLOTS - 1));
}

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

  flush(): void {
    Atomics.add(this.view, GEN, RING_SIZE + 1);
  }

  peerHeld(paths: readonly string[]): void {
    const on = new Set(paths.map(heldSlot));
    for (const slot of on) Atomics.store(this.view, slot, 1);
    for (let slot = HELD; slot < HELD + HELD_SLOTS; slot++) {
      if (!on.has(slot)) Atomics.store(this.view, slot, 0);
    }
  }

  renamed(): number {
    const seq = (Atomics.add(this.view, RENAMES, 1) + 1) | 0;
    Atomics.notify(this.view, RENAMES);
    return seq;
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

  peerHeld(path: string): boolean {
    return this.view.length > HELD && Atomics.load(this.view, heldSlot(path)) === 1;
  }

  renames(): number {
    return this.view.length > RENAMES ? Atomics.load(this.view, RENAMES) : 0;
  }

  awaitRename(seen: number, ms: number): number {
    if (this.view.length > RENAMES) Atomics.wait(this.view, RENAMES, seen, ms);
    return this.renames();
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
