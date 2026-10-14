import { compile, MIN_VALUE, type Scrubber } from '@ai-ecoverse/slicc-scrub';
import { type FdTable, type KernelFile, OpenFile } from './fd-table.ts';

export const SCRUB_IDLE_MS = 50;

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

async function writeAll(file: KernelFile, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  const write = file.write as NonNullable<KernelFile['write']>;
  for (let at = 0; at < bytes.length; ) {
    at += await write.call(file, bytes.subarray(at), at === 0 ? signal : undefined);
  }
}

function bound<K extends keyof KernelFile>(file: KernelFile, key: K): Partial<KernelFile> {
  const method = file[key];
  return typeof method === 'function' ? { [key]: method.bind(file) } : {};
}

export function scrubbed(inner: OpenFile, scrubber: Scrubber, idleMs = SCRUB_IDLE_MS): OpenFile {
  const file = inner.file;
  const stream = scrubber.stream();
  let queue: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failed: unknown;
  const raise = () => {
    if (failed === undefined) return;
    const err = failed;
    failed = undefined;
    throw err;
  };
  const enqueue = (bytes: Uint8Array, signal?: AbortSignal): Promise<void> => {
    const next = queue.then(() => (bytes.length > 0 ? writeAll(file, bytes, signal) : undefined));
    queue = next.catch(() => undefined);
    return next;
  };
  const release = () => {
    timer = undefined;
    enqueue(stream.idle()).catch((err: unknown) => {
      failed = err;
    });
  };
  return new OpenFile({
    ...bound(file, 'read'),
    ...bound(file, 'peek'),
    ...bound(file, 'poll'),
    ...bound(file, 'changed'),
    ...bound(file, 'stat'),
    ...(file.tty ? { tty: file.tty } : {}),
    ...(file.clipboard ? { clipboard: file.clipboard } : {}),
    ...(file.write
      ? {
          write: async (bytes: Uint8Array, signal?: AbortSignal) => {
            if (timer !== undefined) clearTimeout(timer);
            raise();
            await enqueue(stream.push(bytes), signal);
            timer = setTimeout(release, idleMs);
            return bytes.length;
          },
        }
      : {}),
    flush: async () => {
      await queue;
      raise();
      await file.flush?.();
    },
    close: async () => {
      if (timer !== undefined) clearTimeout(timer);
      let failure: { err: unknown } | undefined;
      try {
        await enqueue(stream.end());
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
