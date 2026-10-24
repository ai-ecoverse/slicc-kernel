export const PIPE_CAPACITY = 64 * 1024;

export interface PipeMark {
  readonly at: number;
  readonly count: number;
  drop(): void;
}

export class PipeError extends Error {
  readonly code: 'EPIPE' | 'EINTR' | 'EAGAIN';

  constructor(code: 'EPIPE' | 'EINTR' | 'EAGAIN') {
    super(code);
    this.code = code;
  }
}

export class KernelPipe {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private readers = 0;
  private writers = 0;
  private waiters: Array<() => void> = [];
  private pushed = 0;
  private taken = 0;
  private marks: PipeMark[] = [];

  readonly capacity: number;

  constructor(capacity: number = PIPE_CAPACITY) {
    this.capacity = capacity;
  }

  get buffered(): number {
    return this.size;
  }

  get readReady(): boolean {
    return this.size > 0 || this.writers === 0;
  }

  get writeReady(): boolean {
    return this.size < this.capacity || this.readers === 0;
  }

  get writersGone(): boolean {
    return this.writers === 0;
  }

  get readersGone(): boolean {
    return this.readers === 0;
  }

  openRead(): void {
    this.readers += 1;
  }

  openWrite(): void {
    this.writers += 1;
  }

  closeRead(): void {
    if (this.readers > 0) this.readers -= 1;
    if (this.readers === 0) {
      this.chunks = [];
      this.size = 0;
      this.dropMarks(() => true);
    }
    this.wake();
  }

  closeWrite(): void {
    if (this.writers > 0) this.writers -= 1;
    this.wake();
  }

  async read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    while (this.size === 0) {
      if (this.writers === 0) return new Uint8Array(0);
      await this.changed(signal);
    }
    const out = this.take(this.bounded(Math.min(max, this.size)));
    this.dropMarks((mark) => mark.at < this.taken);
    this.wake();
    return out;
  }

  get inFlight(): number {
    return this.marks.reduce((sum, mark) => sum + mark.count, 0);
  }

  async receive(
    max: number,
    nonblock: boolean,
    signal?: AbortSignal
  ): Promise<{ bytes: Uint8Array; marks: PipeMark[] }> {
    while (this.size === 0) {
      if (this.writers === 0) return { bytes: new Uint8Array(0), marks: [] };
      if (nonblock) throw new PipeError('EAGAIN');
      await this.changed(signal);
    }
    const marks = this.marks.filter((mark) => mark.at === this.taken);
    this.marks = this.marks.filter((mark) => mark.at !== this.taken);
    const bytes = this.take(this.bounded(Math.min(max, this.size)));
    this.dropMarks((mark) => mark.at < this.taken);
    this.wake();
    return { bytes, marks };
  }

  async writeMarked(
    bytes: Uint8Array,
    mark: (at: number) => PipeMark,
    nonblock: boolean,
    signal?: AbortSignal
  ): Promise<number> {
    while (this.readers > 0 && this.size >= this.capacity) {
      if (nonblock) throw new PipeError('EAGAIN');
      await this.changed(signal);
    }
    if (this.readers === 0) throw new PipeError('EPIPE');
    this.marks.push(mark(this.pushed));
    return this.write(bytes, signal);
  }

  private bounded(n: number): number {
    const next = this.marks.find((mark) => mark.at > this.taken);
    return next ? Math.min(n, next.at - this.taken) : n;
  }

  private dropMarks(gone: (mark: PipeMark) => boolean): void {
    const dropped = this.marks.filter(gone);
    if (dropped.length === 0) return;
    this.marks = this.marks.filter((mark) => !gone(mark));
    for (const mark of dropped) mark.drop();
  }

  async peek(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    while (this.size === 0) {
      if (this.writers === 0) return new Uint8Array(0);
      await this.changed(signal);
    }
    const out = new Uint8Array(Math.min(max, this.size));
    let filled = 0;
    for (const chunk of this.chunks) {
      if (filled === out.length) break;
      const count = Math.min(chunk.length, out.length - filled);
      out.set(chunk.subarray(0, count), filled);
      filled += count;
    }
    return out;
  }

  async write(bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.readers === 0) throw new PipeError('EPIPE');
      const room = this.capacity - this.size;
      if (room === 0) {
        try {
          await this.changed(signal);
        } catch (e) {
          if (offset > 0) return offset;
          throw e;
        }
        continue;
      }
      const n = Math.min(room, bytes.length - offset);
      this.chunks.push(bytes.slice(offset, offset + n));
      this.size += n;
      this.pushed += n;
      offset += n;
      this.wake();
    }
    return bytes.length;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      const count = Math.min(head.length, n - filled);
      out.set(head.subarray(0, count), filled);
      filled += count;
      if (count === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(count);
    }
    this.size -= n;
    this.taken += n;
    return out;
  }

  changed(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new PipeError('EINTR'));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new PipeError('EINTR'));
      };
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}
