import { createHash } from 'node:crypto';
import { MessageChannel, type MessagePort, Worker } from 'node:worker_threads';
import type { WasmWorkerLike } from '../kernel/host.ts';
import type { WasmProgram } from '../kernel/protocol.ts';
import type { KernelLink, ProcessLink } from './link.ts';
import { type MessagePortLike, messageLinks } from './message-link.ts';
import { remoteWorker } from './remote-worker.ts';
import type { AsyncProcessInit } from './wire.ts';

export interface AsyncProcessDeps {
  module(image: string): WebAssembly.Module | Promise<WebAssembly.Module>;
}

export type AsyncProcessEntry = (link: KernelLink, deps: AsyncProcessDeps) => void;

export interface AsyncProcessOptions {
  entry?: string | URL;
  inline?: AsyncProcessEntry;
  maxMessageBytes?: number;
}

export interface NodeAsyncHost {
  compile(bytes: Uint8Array, key: string): Promise<WebAssembly.Module>;
  createWorker(closed: boolean): WasmWorkerLike;
}

const TERMINATED = 'the kernel is terminated';

const THREAD_BOOT = `(async () => {
  const { workerData } = require('node:worker_threads');
  const { messageLinks } = await import(workerData.links);
  const loaded = await import(workerData.entry);
  const entry = loaded.asyncProcessEntry ?? loaded.default;
  if (typeof entry !== 'function') throw new Error('async process entry exports no asyncProcessEntry');
  const modules = workerData.modules;
  const waiting = new Map();
  let next = 0;
  modules.on('message', ({ id, module, error }) => {
    const pending = waiting.get(id);
    if (!pending) return;
    waiting.delete(id);
    if (module) pending.resolve(module);
    else pending.reject(new Error(error));
  });
  modules.unref();
  const module = (image) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      modules.ref();
      modules.postMessage({ id, image });
    }).finally(() => {
      if (waiting.size === 0) modules.unref();
    });
  entry(messageLinks(workerData.link).kernel, { module });
})().catch((err) => {
  setImmediate(() => {
    throw err;
  });
});`;

function portOf(port: MessagePort): MessagePortLike {
  return port as unknown as MessagePortLike;
}

function imageRegistry() {
  const images = new Map<string, WebAssembly.Module>();
  const ids = new WeakMap<WebAssembly.Module, string>();
  return {
    async compile(bytes: Uint8Array): Promise<WebAssembly.Module> {
      const module = await WebAssembly.compile(bytes as BufferSource);
      const id = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      images.set(id, module);
      ids.set(module, id);
      return module;
    },
    image: (program: WasmProgram) => ids.get(program.module),
    module(image: string): WebAssembly.Module {
      const module = images.get(image);
      if (!module) throw new Error(`no program image ${image}`);
      return module;
    },
  };
}

function inlineOpen(entry: AsyncProcessEntry, deps: AsyncProcessDeps): () => ProcessLink {
  return () => {
    const { port1, port2 } = new MessageChannel();
    const kernelEnd = messageLinks(portOf(port1));
    const processEnd = messageLinks(portOf(port2));
    queueMicrotask(() => entry(processEnd.kernel, deps));
    return kernelEnd.process;
  };
}

function threadOpen(entry: string, modules: (image: string) => WebAssembly.Module) {
  const links = new URL('./node.js', import.meta.url).href;
  return (): ProcessLink => {
    const link = new MessageChannel();
    const images = new MessageChannel();
    const worker = new Worker(THREAD_BOOT, {
      eval: true,
      workerData: { entry, links, link: link.port2, modules: images.port2 },
      transferList: [link.port2, images.port2],
    });
    const ends = messageLinks(portOf(link.port1));
    images.port1.on('message', ({ id, image }: { id: number; image: string }) => {
      try {
        images.port1.postMessage({ id, module: modules(image) });
      } catch (err) {
        images.port1.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
      }
    });
    let gone = false;
    const stop = (reason: string): void => {
      if (gone) return;
      gone = true;
      images.port1.close();
      ends.close(reason);
      void worker.terminate();
    };
    worker.on('error', (err) => stop(`the process worker failed: ${String(err)}`));
    worker.on('exit', (code) => stop(`the process worker exited with ${code}`));
    return {
      post: ends.process.post,
      onPost: ends.process.onPost,
      onCall: ends.process.onCall,
      onClose: ends.process.onClose,
      close: () => stop('closed'),
    };
  };
}

function entryUrl(entry: string | URL | undefined): string {
  if (entry === undefined) return new URL('./async-process.js', import.meta.url).href;
  return entry instanceof URL ? entry.href : new URL(entry, `file://${process.cwd()}/`).href;
}

export function nodeAsyncHost(options: AsyncProcessOptions, live: Set<() => void>): NodeAsyncHost {
  const registry = imageRegistry();
  const deps: AsyncProcessDeps = { module: (image) => registry.module(image) };
  const open: (init: AsyncProcessInit) => ProcessLink = options.inline
    ? inlineOpen(options.inline, deps)
    : threadOpen(entryUrl(options.entry), (image) => registry.module(image));
  const settings = {
    image: registry.image,
    ...(options.maxMessageBytes !== undefined ? { maxMessageBytes: options.maxMessageBytes } : {}),
  };
  return {
    compile: (bytes) => registry.compile(bytes),
    createWorker(closed) {
      const errors = new Set<(event: MessageEvent) => void>();
      const fail = (message: string) => {
        for (const handler of [...errors]) {
          handler({ message, preventDefault() {} } as unknown as MessageEvent);
        }
      };
      if (closed) {
        setTimeout(() => fail(TERMINATED), 0);
        return {
          postMessage() {},
          addEventListener: (type, handler) => void (type === 'error' && errors.add(handler)),
          removeEventListener: (_type, handler) => void errors.delete(handler),
          terminate() {},
        };
      }
      const worker = remoteWorker(open, settings);
      const kill = () => {
        worker.terminate();
        fail(TERMINATED);
      };
      live.add(kill);
      return {
        postMessage: (message, transfer) => worker.postMessage(message, transfer),
        addEventListener(type, handler) {
          if (type === 'error') errors.add(handler);
          worker.addEventListener(type, handler);
        },
        removeEventListener(type, handler) {
          errors.delete(handler);
          worker.removeEventListener(type, handler);
        },
        terminate() {
          live.delete(kill);
          worker.terminate();
        },
      };
    },
  };
}
