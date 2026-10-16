import type { ChangeView } from './changes.ts';
import { Pages, WRITEBACK } from './pages.ts';

type WatchStat = {
  size: number;
  version?: string | undefined;
  ino?: number | undefined;
  mtimeMs?: number | undefined;
  nlink?: number | undefined;
};

export interface RangedWatch {
  view: ChangeView;
  ino?: number | undefined;
  seen?: number | undefined;
  stat(path: string): WatchStat;
  real?: () => string | undefined;
  linked?: boolean;
  resolved?: string | null;
  sig?: string;
}

export const signatureOf = (st: WatchStat): string =>
  `${st.version ?? ''}:${st.size}:${st.mtimeMs ?? ''}`;

export function linkedWatch<T extends RangedWatch>(watch: T, st: WatchStat): T {
  if ((st.nlink ?? 1) < 2) return watch;
  watch.linked = true;
  watch.sig = signatureOf(st);
  return watch;
}

function viaAlias(watch: RangedWatch, seen: number, path: string): boolean {
  if (watch.resolved === undefined) {
    let real: string | undefined;
    try {
      real = watch.real?.();
    } catch {}
    watch.resolved = real && real !== path ? real : null;
  }
  return watch.resolved !== null && watch.view.changedSince(seen, watch.resolved).changed;
}

function viaLink(watch: RangedWatch, path: string): boolean {
  if (!watch.linked) return false;
  let sig: string;
  try {
    sig = signatureOf(watch.stat(path));
  } catch {
    return false;
  }
  if (sig === watch.sig) return false;
  watch.sig = sig;
  return true;
}

export function watchedChange(
  watch: RangedWatch,
  seen: number,
  path: string
): { now: number; changed: boolean } {
  const said = watch.view.changedSince(seen, path);
  if (said.changed || said.now === seen) return said;
  return { now: said.now, changed: viaAlias(watch, seen, path) || viaLink(watch, path) };
}

export interface RangedIo {
  pread(path: string, offset: number, length: number, version?: string): Uint8Array;
  pwrite(path: string, offset: number, bytes: Uint8Array, transfer?: boolean): void;
  truncate(path: string, size: number): void;
}

export interface AsyncRangedIo {
  pread(path: string, offset: number, length: number, version?: string): Promise<Uint8Array>;
  pwrite(path: string, offset: number, bytes: Uint8Array, transfer?: boolean): Promise<void>;
  truncate(path: string, size: number): Promise<void>;
}

export class RangedFile {
  private readonly pages: Pages;
  private readonly io: RangedIo;
  private pinned = false;
  private version: string | undefined;
  private readonly watch: RangedWatch | undefined;
  private seen = 0;
  path: string;

  constructor(io: RangedIo, path: string, size: number, version?: string, watch?: RangedWatch) {
    this.io = io;
    this.path = path;
    this.version = version;
    this.pages = new Pages(size);
    this.watch = watch;
    if (watch) this.seen = watch.seen ?? watch.view.now();
  }

  private fresh(): void {
    const watch = this.watch;
    if (!watch || this.pinned) return;
    const { now, changed } = watchedChange(watch, this.seen, this.path);
    this.seen = now;
    if (!changed) return;
    let st: ReturnType<RangedWatch['stat']>;
    try {
      st = watch.stat(this.path);
    } catch {
      return;
    }
    if (watch.ino !== undefined && st.ino !== watch.ino) return;
    console.error(`ZZY fresh adopts ${this.path} ${this.version} -> ${st.version}`);
    this.version = st.version;
    this.pages.refresh(st.size);
  }

  get changed(): boolean {
    return this.pages.changed;
  }

  get pinnedVersion(): string | undefined {
    return this.version;
  }

  forget(): void {
    this.pages.reset(this.pages.length);
  }

  size(): number {
    this.fresh();
    return this.pages.length;
  }

  private fetch(runs: Array<[number, number]>): void {
    for (const [start, n] of runs) {
      this.pages.fill(start, this.io.pread(this.path, start, n, this.version));
    }
  }

  read(at: number, length: number): Uint8Array {
    this.fresh();
    this.fetch(this.pages.missing(at, length));
    return this.pages.read(at, length);
  }

  readInto(at: number, out: Uint8Array): number {
    this.fresh();
    this.fetch(this.pages.missing(at, out.length));
    return this.pages.readInto(at, out);
  }

  write(at: number, bytes: Uint8Array): void {
    this.fresh();
    this.fetch(this.pages.partial(at, bytes.length));
    this.pages.write(at, bytes);
    if (!this.pinned && this.pages.dirtyBytes >= WRITEBACK) this.flush();
  }

  truncate(size: number): void {
    this.pages.truncate(size);
  }

  flush(): void {
    if (this.pinned || !this.pages.changed) return;
    const plan = this.pages.plan();
    if (plan.shrink !== undefined) this.io.truncate(this.path, plan.shrink);
    for (const run of plan.runs) this.io.pwrite(this.path, run.offset, run.bytes, true);
    if (plan.extend !== undefined) this.io.truncate(this.path, plan.extend);
    this.version = undefined;
    this.pages.flushed();
  }

  pin(): void {
    this.pinned = true;
    this.pages.pin();
    this.fetch(this.pages.missing(0, this.pages.length));
  }

  reset(size: number): void {
    this.pages.reset(size);
  }
}

export class AsyncRangedFile {
  private readonly pages: Pages;
  private readonly io: AsyncRangedIo;
  private pinned = false;
  private version: string | undefined;
  path: string;

  constructor(io: AsyncRangedIo, path: string, size: number, version?: string) {
    this.io = io;
    this.path = path;
    this.version = version;
    this.pages = new Pages(size);
  }

  size(): number {
    return this.pages.length;
  }

  private async fetch(runs: Array<[number, number]>): Promise<void> {
    for (const [start, n] of runs) {
      this.pages.fill(start, await this.io.pread(this.path, start, n, this.version));
    }
  }

  async read(at: number, length: number): Promise<Uint8Array> {
    await this.fetch(this.pages.missing(at, length));
    return this.pages.read(at, length);
  }

  async write(at: number, bytes: Uint8Array): Promise<void> {
    await this.fetch(this.pages.partial(at, bytes.length));
    this.pages.write(at, bytes);
    if (!this.pinned && this.pages.dirtyBytes >= WRITEBACK) await this.flush();
  }

  truncate(size: number): void {
    this.pages.truncate(size);
  }

  async flush(): Promise<void> {
    if (this.pinned || !this.pages.changed) return;
    const plan = this.pages.plan();
    if (plan.shrink !== undefined) await this.io.truncate(this.path, plan.shrink);
    for (const run of plan.runs) await this.io.pwrite(this.path, run.offset, run.bytes, true);
    if (plan.extend !== undefined) await this.io.truncate(this.path, plan.extend);
    this.version = undefined;
    this.pages.flushed();
  }

  async pin(): Promise<void> {
    this.pinned = true;
    this.pages.pin();
    await this.fetch(this.pages.missing(0, this.pages.length));
  }
}
