import { compile, MIN_VALUE, type Scrubber } from '@ai-ecoverse/slicc-scrub';
import { type FdTable, KernelError, type KernelFile, OpenFile, pollFile } from './fd-table.ts';

export const SCRUB_IDLE_MS = 50;

export const SCRUB_NONBLOCK_MAX = 64 * 1024;

const encoder = new TextEncoder();

export interface ScrubSecret {
  name: string;
  value: string;
  placeholder: string;
}

export function scrubberOf(secrets: ScrubSecret[]): Scrubber | undefined {
  const usable = secrets.filter((s) => encoder.encode(s.value).length >= MIN_VALUE);
  return usable.length > 0 ? compile(usable, { idleMs: SCRUB_IDLE_MS }) : undefined;
}

async function writeAll(file: KernelFile, bytes: Uint8Array): Promise<void> {
  const write = file.write as NonNullable<KernelFile['write']>;
  for (let at = 0; at < bytes.length; ) at += await write.call(file, bytes.subarray(at));
}

function bound<K extends keyof KernelFile>(file: KernelFile, key: K): Partial<KernelFile> {
  const method = file[key];
  return typeof method === 'function' ? { [key]: method.bind(file) } : {};
}

function interrupted(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'EINTR' || code === 'EAGAIN';
}

export function scrubbed(inner: OpenFile, scrubber: Scrubber, idleMs = SCRUB_IDLE_MS): OpenFile {
  const file = inner.file;
  const stream = scrubber.stream();
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failed: unknown;
  const waiters = new Set<() => void>();
  const quiet = () => !busy && pending === 0;
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const raise = () => {
    if (failed === undefined) return;
    const err = failed;
    failed = undefined;
    throw err;
  };
  const later = (bytes: Uint8Array): void => {
    if (bytes.length === 0) return;
    pending += 1;
    tail = tail
      .then(() => writeAll(file, bytes))
      .catch((err: unknown) => {
        if (failed === undefined) failed = err;
      })
      .finally(() => {
        pending -= 1;
        if (quiet()) wake();
      });
  };
  const settling = (signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const done = () => {
        waiters.delete(done);
        signal?.removeEventListener('abort', stop);
        resolve();
      };
      const stop = () => {
        waiters.delete(done);
        reject(new KernelError('EINTR'));
      };
      if (signal?.aborted) return stop();
      waiters.add(done);
      signal?.addEventListener('abort', stop, { once: true });
    });
  const settled = async (): Promise<void> => {
    while (!quiet()) await settling();
  };
  const changed = async (signal?: AbortSignal): Promise<void> => {
    const round = new AbortController();
    const stop = signal ? AbortSignal.any([signal, round.signal]) : round.signal;
    try {
      const own = settling(stop);
      await Promise.race(file.changed ? [own, file.changed(stop)] : [own]);
    } catch (err) {
      throw signal?.aborted ? new KernelError('EINTR') : err;
    } finally {
      round.abort();
    }
  };
  const turn = async (signal?: AbortSignal): Promise<void> => {
    for (let waited = false; ; waited = true) {
      if (quiet() && (pollFile(file).writable || !file.changed)) {
        busy = true;
        return;
      }
      if (signal?.aborted) throw new KernelError(waited ? 'EINTR' : 'EAGAIN');
      await changed(signal);
    }
  };
  const send = async (out: Uint8Array, signal?: AbortSignal): Promise<void> => {
    const write = file.write as NonNullable<KernelFile['write']>;
    for (let at = 0; at < out.length; ) {
      try {
        at += await write.call(file, out.subarray(at), signal);
      } catch (err) {
        if (!signal?.aborted || !interrupted(err)) throw err;
      }
      if (at < out.length && signal?.aborted) return later(out.subarray(at));
    }
  };
  const release = () => {
    timer = undefined;
    later(stream.idle());
  };
  return new OpenFile({
    ...bound(file, 'read'),
    ...bound(file, 'peek'),
    ...bound(file, 'stat'),
    poll: () => {
      const state = pollFile(file);
      return quiet() ? state : { ...state, writable: false };
    },
    changed,
    ...(file.tty ? { tty: file.tty } : {}),
    identity: file.identity ?? file,
    ...(file.clipboard ? { clipboard: file.clipboard } : {}),
    ...(file.write
      ? {
          write: async (bytes: Uint8Array, signal?: AbortSignal) => {
            await turn(signal);
            const taken =
              signal?.aborted && bytes.length > SCRUB_NONBLOCK_MAX
                ? bytes.subarray(0, SCRUB_NONBLOCK_MAX)
                : bytes;
            try {
              raise();
              if (timer !== undefined) clearTimeout(timer);
              timer = undefined;
              await send(stream.push(taken), signal);
            } finally {
              busy = false;
              if (quiet()) wake();
            }
            timer = setTimeout(release, idleMs);
            return taken.length;
          },
        }
      : {}),
    flush: async () => {
      await settled();
      raise();
      await file.flush?.();
    },
    close: async () => {
      if (timer !== undefined) clearTimeout(timer);
      let failure: { err: unknown } | undefined;
      try {
        await settled();
        later(stream.end());
        await settled();
        raise();
      } catch (err) {
        failure = { err };
      }
      await inner.release();
      if (failure) throw failure.err;
    },
  });
}

export function scrubbedAll(file: OpenFile, scrubbers: readonly Scrubber[]): OpenFile {
  return scrubbers.reduce((inner, scrubber) => scrubbed(inner, scrubber), file);
}

function stdioFiles(fds: FdTable): Set<OpenFile> {
  const files = new Set<OpenFile>();
  for (const fd of [1, 2]) {
    try {
      files.add(fds.get(fd));
    } catch {}
  }
  return files;
}

export function scrubStdio(fds: FdTable, scrubber: Scrubber): void {
  const wrapped = new Map<OpenFile, OpenFile>();
  const stdio = stdioFiles(fds);
  for (const fd of fds.numbers()) {
    const original = fds.get(fd);
    if (!stdio.has(original) && !original.file.tty && !original.file.clipboard) continue;
    const known = wrapped.get(original);
    const flags = fds.statusFlags(fd);
    const wrapper = known ? known.retain() : scrubbed(original.retain(), scrubber);
    wrapped.set(original, wrapper);
    fds.installAt(fd, wrapper);
    if (flags !== undefined) fds.setStatusFlags(fd, flags);
  }
}
