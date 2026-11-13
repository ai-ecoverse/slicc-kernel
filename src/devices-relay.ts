import type { DeviceHook, DeviceStamp, DeviceStreams } from './kernel/devices.ts';

export interface DevicesPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

interface Failure {
  name: string;
  message: string;
}

export type DevicesToPage =
  | { id: number; open: { client: number; path: string; flags: number; stamp: DeviceStamp } }
  | { id: number; pull: true }
  | { id: number; write: Uint8Array; seq: number }
  | { id: number; control: { seq: number; op: string; args?: object } }
  | { id: number; cancel: string };

export type DevicesToKernel =
  | { id: number; opened: true }
  | { id: number; failed: Failure }
  | { id: number; chunk: Uint8Array }
  | { id: number; done: true }
  | { id: number; readError: Failure }
  | { id: number; wrote: number }
  | { id: number; writeError: Failure; seq: number }
  | { id: number; answered: number; value?: unknown }
  | { id: number; refused: number; error: Failure };

function quiet(): undefined {
  return undefined;
}

function errorOf(err: unknown): Failure {
  const name = (err as { name?: unknown } | null)?.name;
  const message = err instanceof Error ? err.message : String(err);
  return { name: typeof name === 'string' ? name : 'Error', message };
}

function raised(failure: Failure): Error {
  return Object.assign(new Error(failure.message), { name: failure.name });
}

function fresh(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
}

interface Remote {
  opened: PromiseWithResolvers<void>;
  chunks: Array<Uint8Array | null | Failure>;
  wake: (() => void) | undefined;
  writes: Map<number, PromiseWithResolvers<void>>;
  controls: Map<number, PromiseWithResolvers<unknown>>;
  seq: number;
}

export function devicesAsker(port: DevicesPort) {
  const remotes = new Map<number, Remote>();
  let next = 0;
  const post = (message: DevicesToPage, transfer: Transferable[] = []) =>
    port.postMessage({ devices: message }, transfer);
  const push = (remote: Remote, item: Remote['chunks'][number]) => {
    remote.chunks.push(item);
    remote.wake?.();
  };
  const streams = (id: number, remote: Remote): DeviceStreams => ({
    readable: new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          if (remote.chunks.length === 0) {
            post({ id, pull: true });
            await new Promise<void>((resolve) => {
              remote.wake = resolve;
            });
          }
          const item = remote.chunks.shift();
          if (item instanceof Uint8Array) controller.enqueue(item);
          else if (item === null || item === undefined) controller.close();
          else controller.error(raised(item));
        },
        cancel: (reason) => {
          post({ id, cancel: String(reason ?? 'closed') });
        },
      },
      { highWaterMark: 0 }
    ),
    writable: new WritableStream<Uint8Array>({
      write: (chunk) => {
        const seq = ++remote.seq;
        const done = Promise.withResolvers<void>();
        remote.writes.set(seq, done);
        const bytes = fresh(chunk);
        post({ id, write: bytes, seq }, [bytes.buffer as ArrayBuffer]);
        return done.promise;
      },
      abort: (reason) => {
        post({ id, cancel: String(reason ?? 'closed') });
      },
    }),
    control: (op, args) => {
      const seq = ++remote.seq;
      const done = Promise.withResolvers<unknown>();
      remote.controls.set(seq, done);
      post({ id, control: { seq, op, ...(args ? { args } : {}) } });
      if (op === 'close') void done.promise.finally(() => remotes.delete(id)).catch(quiet);
      return done.promise;
    },
  });
  const hookFor = (client: number): DeviceHook => ({
    open: async (request) => {
      const id = ++next;
      const remote: Remote = {
        opened: Promise.withResolvers<void>(),
        chunks: [],
        wake: undefined,
        writes: new Map(),
        controls: new Map(),
        seq: 0,
      };
      remotes.set(id, remote);
      const abort = () => {
        remotes.delete(id);
        post({ id, cancel: 'interrupted' });
        remote.opened.reject(request.signal.reason);
      };
      request.signal.addEventListener('abort', abort, { once: true });
      const { path, flags, stamp } = request;
      post({ id, open: { client, path, flags, stamp } });
      try {
        await remote.opened.promise;
      } finally {
        request.signal.removeEventListener('abort', abort);
      }
      return streams(id, remote);
    },
  });
  const answer = (message: DevicesToKernel): void => {
    const remote = remotes.get(message.id);
    if (!remote) return;
    if ('opened' in message) remote.opened.resolve();
    else if ('failed' in message) {
      remotes.delete(message.id);
      remote.opened.reject(raised(message.failed));
    } else if ('chunk' in message) push(remote, message.chunk);
    else if ('done' in message) push(remote, null);
    else if ('readError' in message) push(remote, message.readError);
    else if ('wrote' in message) {
      remote.writes.get(message.wrote)?.resolve();
      remote.writes.delete(message.wrote);
    } else if ('writeError' in message) {
      remote.writes.get(message.seq)?.reject(raised(message.writeError));
      remote.writes.delete(message.seq);
    } else if ('answered' in message) {
      remote.controls.get(message.answered)?.resolve(message.value);
      remote.controls.delete(message.answered);
    } else {
      remote.controls.get(message.refused)?.reject(raised(message.error));
      remote.controls.delete(message.refused);
    }
  };
  return { hookFor, answer };
}

interface Local {
  abort: AbortController;
  closing?: Promise<void>;
  streams?: DeviceStreams;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  writer?: WritableStreamDefaultWriter<Uint8Array>;
}

export function devicesAnswerer(
  port: DevicesPort,
  hookFor: (client: number) => DeviceHook | undefined
): { handle(data: unknown): boolean } {
  const locals = new Map<number, Local>();
  const post = (message: DevicesToKernel, transfer: Transferable[] = []) =>
    port.postMessage({ devicesReply: message }, transfer);
  const open = async (
    id: number,
    asked: Extract<DevicesToPage, { open: unknown }>['open']
  ): Promise<void> => {
    const local: Local = { abort: new AbortController() };
    locals.set(id, local);
    try {
      const hook = hookFor(asked.client);
      if (!hook)
        throw Object.assign(new Error('this page has no devices hook'), {
          name: 'NotSupportedError',
        });
      const streams = await hook.open({
        path: asked.path,
        flags: asked.flags,
        stamp: asked.stamp,
        signal: local.abort.signal,
      });
      if (!locals.has(id)) {
        await streams?.readable?.cancel('closed').catch(quiet);
        await streams?.writable?.abort('closed').catch(quiet);
        await Promise.resolve(streams?.control?.('close')).catch(quiet);
        return;
      }
      local.streams = streams;
      local.reader = streams.readable.getReader();
      local.writer = streams.writable.getWriter();
      post({ id, opened: true });
    } catch (err) {
      locals.delete(id);
      post({ id, failed: errorOf(err) });
    }
  };
  const pull = async (id: number, local: Local): Promise<void> => {
    try {
      const got = await (local.reader as ReadableStreamDefaultReader<Uint8Array>).read();
      if (got.done) return post({ id, done: true });
      const bytes = fresh(got.value);
      post({ id, chunk: bytes }, [bytes.buffer as ArrayBuffer]);
    } catch (err) {
      post({ id, readError: errorOf(err) });
    }
  };
  const write = async (id: number, local: Local, bytes: Uint8Array, seq: number) => {
    try {
      await (local.writer as WritableStreamDefaultWriter<Uint8Array>).write(bytes);
      post({ id, wrote: seq });
    } catch (err) {
      post({ id, writeError: errorOf(err), seq });
    }
  };
  const control = async (
    id: number,
    local: Local,
    asked: { seq: number; op: string; args?: object }
  ) => {
    try {
      await local.closing;
      const value = await (local.streams as DeviceStreams).control(asked.op, asked.args);
      post({ id, answered: asked.seq, ...(value !== undefined ? { value } : {}) });
    } catch (err) {
      post({ id, refused: asked.seq, error: errorOf(err) });
    }
    if (asked.op === 'close') locals.delete(id);
  };
  const release = async (local: Local, reason: string): Promise<void> => {
    const { reader, writer } = local;
    local.reader = undefined;
    local.writer = undefined;
    await reader?.cancel(reason).catch(quiet);
    reader?.releaseLock();
    await writer?.abort(reason).catch(quiet);
    writer?.releaseLock();
  };
  const cancel = (id: number, local: Local, reason: string): void => {
    local.abort.abort(new DOMException(reason, 'AbortError'));
    if (!local.streams) {
      locals.delete(id);
      return;
    }
    local.closing = Promise.resolve(local.closing).then(() => release(local, reason));
  };
  return {
    handle(data) {
      const message = (data as { devices?: DevicesToPage } | null)?.devices;
      if (!message) return false;
      if ('open' in message) {
        void open(message.id, message.open);
        return true;
      }
      const local = locals.get(message.id);
      if (!local) return true;
      if ('pull' in message) void pull(message.id, local);
      else if ('write' in message) void write(message.id, local, message.write, message.seq);
      else if ('control' in message) void control(message.id, local, message.control);
      else cancel(message.id, local, message.cancel);
      return true;
    },
  };
}

export function devicesReplyOf(data: unknown): DevicesToKernel | undefined {
  return (data as { devicesReply?: DevicesToKernel } | null)?.devicesReply;
}
