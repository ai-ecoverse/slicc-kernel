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
  for (let at = 0; at < bytes.length; ) at += await write.call(file, bytes.subarray(at), signal);
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
  const enqueue = (bytes: Uint8Array, signal?: AbortSignal): Promise<void> => {
    const next = queue.then(() => (bytes.length > 0 ? writeAll(file, bytes, signal) : undefined));
    queue = next.catch(() => undefined);
    return next;
  };
  const release = () => {
    timer = undefined;
    void enqueue(stream.idle()).catch(() => undefined);
  };
  return new OpenFile({
    ...bound(file, 'read'),
    ...bound(file, 'peek'),
    ...bound(file, 'poll'),
    ...bound(file, 'changed'),
    ...bound(file, 'stat'),
    ...(file.tty ? { tty: file.tty } : {}),
    ...(file.write
      ? {
          write: async (bytes: Uint8Array, signal?: AbortSignal) => {
            if (timer !== undefined) clearTimeout(timer);
            await enqueue(stream.push(bytes), signal);
            timer = setTimeout(release, idleMs);
            return bytes.length;
          },
        }
      : {}),
    flush: async () => {
      await queue;
      await file.flush?.();
    },
    close: async () => {
      if (timer !== undefined) clearTimeout(timer);
      await enqueue(stream.end()).catch(() => undefined);
      await inner.release();
    },
  });
}

export function scrubStdio(fds: FdTable, scrubber: Scrubber): void {
  const wrapped = new Map<OpenFile, OpenFile>();
  for (const fd of [1, 2]) {
    let original: OpenFile;
    try {
      original = fds.get(fd);
    } catch {
      continue;
    }
    const known = wrapped.get(original);
    const flags = fds.statusFlags(fd);
    const wrapper = known ? known.retain() : scrubbed(original.retain(), scrubber);
    wrapped.set(original, wrapper);
    fds.installAt(fd, wrapper);
    if (flags !== undefined) fds.setStatusFlags(fd, flags);
  }
}
