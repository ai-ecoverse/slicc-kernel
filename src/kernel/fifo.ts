import { KernelError, type OpenAccess, OpenFile } from './fd-table.ts';
import { KernelPipe, type PipeError } from './pipe.ts';

interface Fifo {
  pipe: KernelPipe;
  readers: number;
  writers: number;
  readOpens: number;
  writeOpens: number;
  waiters: Array<() => void>;
}

function errno(e: unknown): KernelError {
  return e instanceof KernelError ? e : new KernelError((e as PipeError).code ?? 'EIO');
}

export class FifoTable {
  private readonly fifos = new Map<string, Fifo>();

  size(): number {
    return this.fifos.size;
  }

  async open(
    key: string,
    path: string,
    access: OpenAccess,
    nonblock: boolean,
    signal: AbortSignal
  ): Promise<OpenFile> {
    const fifo = this.entry(key);
    if (access === 'write' && nonblock && fifo.readers === 0) {
      this.drop(key, fifo);
      throw new KernelError('ENXIO');
    }
    const reads = access !== 'write';
    const writes = access !== 'read';
    const seen = { readOpens: fifo.readOpens, writeOpens: fifo.writeOpens };
    if (reads) this.count(fifo, 'readers', 1);
    if (writes) this.count(fifo, 'writers', 1);
    this.notify(fifo);
    try {
      if (!nonblock && access === 'read') {
        while (fifo.writers === 0 && fifo.writeOpens === seen.writeOpens) {
          await this.changed(fifo, signal);
        }
      }
      if (!nonblock && access === 'write') {
        while (fifo.readers === 0 && fifo.readOpens === seen.readOpens) {
          await this.changed(fifo, signal);
        }
      }
    } catch (e) {
      this.release(key, fifo, reads, writes);
      throw errno(e);
    }
    return this.end(key, path, fifo, reads, writes);
  }

  private entry(key: string): Fifo {
    let fifo = this.fifos.get(key);
    if (!fifo) {
      fifo = {
        pipe: new KernelPipe(),
        readers: 0,
        writers: 0,
        readOpens: 0,
        writeOpens: 0,
        waiters: [],
      };
      this.fifos.set(key, fifo);
    }
    return fifo;
  }

  private count(fifo: Fifo, side: 'readers' | 'writers', by: 1 | -1): void {
    fifo[side] += by;
    if (side === 'readers') {
      if (by > 0) {
        fifo.readOpens += 1;
        fifo.pipe.openRead();
      } else fifo.pipe.closeRead();
    } else if (by > 0) {
      fifo.writeOpens += 1;
      fifo.pipe.openWrite();
    } else fifo.pipe.closeWrite();
  }

  private notify(fifo: Fifo): void {
    const waiters = fifo.waiters;
    fifo.waiters = [];
    for (const wake of waiters) wake();
  }

  private changed(fifo: Fifo, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new KernelError('EINTR'));
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        fifo.waiters = fifo.waiters.filter((w) => w !== wake);
        reject(new KernelError('EINTR'));
      };
      const wake = (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      fifo.waiters.push(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(key: string, fifo: Fifo, reads: boolean, writes: boolean): void {
    if (reads) this.count(fifo, 'readers', -1);
    if (writes) this.count(fifo, 'writers', -1);
    this.notify(fifo);
    this.drop(key, fifo);
  }

  private drop(key: string, fifo: Fifo): void {
    const idle = fifo.readers === 0 && fifo.writers === 0 && fifo.waiters.length === 0;
    if (idle && this.fifos.get(key) === fifo) this.fifos.delete(key);
  }

  private end(key: string, path: string, fifo: Fifo, reads: boolean, writes: boolean): OpenFile {
    const { pipe } = fifo;
    let open = true;
    return new OpenFile({
      fifo: path,
      identity: fifo,
      ...(reads
        ? {
            read: async (max: number, signal?: AbortSignal) => {
              try {
                return await pipe.read(max, signal);
              } catch (e) {
                throw errno(e);
              }
            },
          }
        : {}),
      ...(writes
        ? {
            write: async (bytes: Uint8Array, signal?: AbortSignal) => {
              try {
                return await pipe.write(bytes, signal);
              } catch (e) {
                throw errno(e);
              }
            },
          }
        : {}),
      close: () => {
        if (!open) return;
        open = false;
        this.release(key, fifo, reads, writes);
      },
      poll: () => ({
        readable: reads && pipe.readReady,
        writable: writes && pipe.writeReady,
        hangup: reads ? pipe.writersGone : pipe.readersGone,
        ...(reads ? { nread: pipe.buffered } : {}),
      }),
      changed: (signal) => pipe.changed(signal),
    });
  }
}
