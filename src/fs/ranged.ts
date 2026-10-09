import { Pages, WRITEBACK } from './pages.ts';

export interface RangedIo {
  pread(path: string, offset: number, length: number): Uint8Array;
  pwrite(path: string, offset: number, bytes: Uint8Array, transfer?: boolean): void;
  truncate(path: string, size: number): void;
}

export interface AsyncRangedIo {
  pread(path: string, offset: number, length: number): Promise<Uint8Array>;
  pwrite(path: string, offset: number, bytes: Uint8Array, transfer?: boolean): Promise<void>;
  truncate(path: string, size: number): Promise<void>;
}

export class RangedFile {
  private readonly pages: Pages;
  private readonly io: RangedIo;
  private pinned = false;
  path: string;

  constructor(io: RangedIo, path: string, size: number) {
    this.io = io;
    this.path = path;
    this.pages = new Pages(size);
  }

  get changed(): boolean {
    return this.pages.changed;
  }

  size(): number {
    return this.pages.length;
  }

  private fetch(runs: Array<[number, number]>): void {
    for (const [start, n] of runs) this.pages.fill(start, this.io.pread(this.path, start, n));
  }

  read(at: number, length: number): Uint8Array {
    this.fetch(this.pages.missing(at, length));
    return this.pages.read(at, length);
  }

  readInto(at: number, out: Uint8Array): number {
    this.fetch(this.pages.missing(at, out.length));
    return this.pages.readInto(at, out);
  }

  write(at: number, bytes: Uint8Array): void {
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
  path: string;

  constructor(io: AsyncRangedIo, path: string, size: number) {
    this.io = io;
    this.path = path;
    this.pages = new Pages(size);
  }

  size(): number {
    return this.pages.length;
  }

  private async fetch(runs: Array<[number, number]>): Promise<void> {
    for (const [start, n] of runs) this.pages.fill(start, await this.io.pread(this.path, start, n));
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
    this.pages.flushed();
  }

  async pin(): Promise<void> {
    this.pinned = true;
    this.pages.pin();
    await this.fetch(this.pages.missing(0, this.pages.length));
  }
}
