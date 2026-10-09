export const PAGE = 64 * 1024;
export const READAHEAD = 1024 * 1024;
export const CLEAN_LIMIT = 4 * 1024 * 1024;
export const WRITEBACK = 8 * 1024 * 1024;
export const RUN = 1024 * 1024;

export interface Run {
  offset: number;
  bytes: Uint8Array;
}

export interface FlushPlan {
  shrink?: number;
  runs: Run[];
  extend?: number;
}

export class Pages {
  length: number;
  private stored: number;
  private shrink: number | undefined;
  private readonly pages = new Map<number, Uint8Array>();
  private readonly dirty = new Set<number>();
  private readonly free: Uint8Array[] = [];
  private pinned = false;

  constructor(size: number) {
    this.length = size;
    this.stored = size;
  }

  get dirtyBytes(): number {
    return this.dirty.size * PAGE;
  }

  get changed(): boolean {
    return this.dirty.size > 0 || this.shrink !== undefined || this.length !== this.stored;
  }

  missing(at: number, length: number): Array<[number, number]> {
    this.evict();
    const end = Math.min(this.stored, at + length, this.length);
    const runs: Array<[number, number]> = [];
    for (let page = Math.floor(at / PAGE); page * PAGE < end; page++) {
      if (this.pages.has(page)) continue;
      const last = runs[runs.length - 1];
      if (last && last[0] + last[1] === page * PAGE) last[1] += PAGE;
      else runs.push([page * PAGE, PAGE]);
    }
    const last = runs[runs.length - 1];
    if (last) last[1] = Math.max(last[1], Math.min(READAHEAD, this.stored - last[0]));
    return runs.map(([start, n]) => [start, Math.min(n, this.stored - start)]);
  }

  partial(at: number, length: number): Array<[number, number]> {
    if (length === 0) return [];
    this.evict();
    const edges = new Set([Math.floor(at / PAGE), Math.floor((at + length - 1) / PAGE)]);
    const runs: Array<[number, number]> = [];
    for (const page of edges) {
      const start = page * PAGE;
      const covered = at <= start && at + length >= start + PAGE;
      if (covered || this.pages.has(page) || start >= this.stored) continue;
      runs.push([start, Math.min(PAGE, this.stored - start)]);
    }
    return runs;
  }

  fill(start: number, bytes: Uint8Array): void {
    for (let at = 0; at < bytes.length; at += PAGE) {
      const page = (start + at) / PAGE;
      if (this.pages.has(page)) continue;
      const part = bytes.subarray(at, Math.min(at + PAGE, bytes.length));
      const fresh = this.take(part.length);
      fresh.set(part);
      this.pages.set(page, fresh);
    }
  }

  read(at: number, length: number): Uint8Array {
    const out = new Uint8Array(Math.max(0, Math.min(this.length, at + length) - at));
    this.readInto(at, out);
    return out;
  }

  readInto(at: number, out: Uint8Array): number {
    const end = Math.min(this.length, at + out.length);
    for (let pos = at; pos < end; ) {
      const page = Math.floor(pos / PAGE);
      const from = pos - page * PAGE;
      const n = Math.min(PAGE - from, end - pos);
      const bytes = this.pages.get(page);
      if (bytes) out.set(bytes.subarray(from, from + n), pos - at);
      else out.fill(0, pos - at, pos - at + n);
      pos += n;
    }
    return Math.max(0, end - at);
  }

  write(at: number, bytes: Uint8Array): void {
    for (let done = 0; done < bytes.length; ) {
      const pos = at + done;
      const page = Math.floor(pos / PAGE);
      const from = pos - page * PAGE;
      const n = Math.min(PAGE - from, bytes.length - done);
      let target = this.pages.get(page);
      if (!target) {
        target = this.take(0);
        this.pages.set(page, target);
      }
      target.set(bytes.subarray(done, done + n), from);
      this.dirty.add(page);
      done += n;
    }
    this.length = Math.max(this.length, at + bytes.length);
  }

  truncate(size: number): void {
    if (size < this.stored) {
      this.stored = size;
      this.shrink = Math.min(this.shrink ?? size, size);
    }
    if (size < this.length) {
      const edge = Math.floor(size / PAGE);
      for (const page of [...this.pages.keys()]) {
        if (page > edge || (page === edge && size === edge * PAGE)) this.drop(page);
      }
      this.pages.get(edge)?.fill(0, size - edge * PAGE);
    }
    this.length = size;
  }

  plan(): FlushPlan {
    const runs: Run[] = [];
    const sorted = [...this.dirty].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; ) {
      let j = i + 1;
      const first = sorted[i] as number;
      while (
        j < sorted.length &&
        sorted[j] === first + (j - i) &&
        ((sorted[j] as number) * PAGE) % RUN !== 0
      ) {
        j++;
      }
      const start = first * PAGE;
      const end = Math.min(this.length, (first + (j - i)) * PAGE);
      const bytes = new Uint8Array(end - start);
      for (let k = i; k < j; k++) {
        const page = this.pages.get(sorted[k] as number) as Uint8Array;
        bytes.set(page.subarray(0, Math.min(PAGE, end - (k - i) * PAGE - start)), (k - i) * PAGE);
      }
      runs.push({ offset: start, bytes });
      i = j;
    }
    const written = Math.max(this.stored, ...runs.map((r) => r.offset + r.bytes.length));
    return {
      ...(this.shrink !== undefined ? { shrink: this.shrink } : {}),
      runs,
      ...(this.length > written ? { extend: this.length } : {}),
    };
  }

  flushed(): void {
    this.dirty.clear();
    this.shrink = undefined;
    this.stored = this.length;
    this.evict();
  }

  pin(): void {
    this.pinned = true;
  }

  reset(size: number): void {
    if (this.pinned) return;
    for (const page of [...this.pages.keys()]) if (!this.dirty.has(page)) this.drop(page);
    if (this.changed) return;
    this.length = size;
    this.stored = size;
  }

  private evict(): void {
    if (this.pinned) return;
    let clean = (this.pages.size - this.dirty.size) * PAGE;
    for (const page of this.pages.keys()) {
      if (clean <= CLEAN_LIMIT) return;
      if (this.dirty.has(page)) continue;
      this.drop(page);
      clean -= PAGE;
    }
  }

  private take(used: number): Uint8Array {
    const page = this.free.pop();
    if (!page) return new Uint8Array(PAGE);
    page.fill(0, used);
    return page;
  }

  private drop(page: number): void {
    const bytes = this.pages.get(page) as Uint8Array;
    this.pages.delete(page);
    this.dirty.delete(page);
    if (this.free.length < CLEAN_LIMIT / PAGE) this.free.push(bytes);
  }
}
