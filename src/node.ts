import { MessageChannel, type MessagePort, Worker } from 'node:worker_threads';
import type { MessagePortLike } from './client/protocol.ts';
import { type ServedClient, serveClient } from './client/serve-client.ts';
import { OpfsFs } from './fs/opfs.ts';
import type { RunOptions, RunResult, Terminal, TerminalOptions } from './index.ts';
import type { WasmWorkerLike } from './kernel/host.ts';
import { Launcher } from './launcher.ts';
import { memoryRoot } from './node/memory-root.ts';
import { signalNumber } from './serve.ts';
import { fetchTransport, type NetworkTransport } from './transport.ts';

export {
  type AttachOptions,
  attachKernel,
  type ClientFetchRequest,
  type ClientFs,
  type ClientRunOptions,
  type ClientRunResult,
  type ClientTerminal,
  type ClientTerminalOptions,
  KernelCallError,
  type KernelClient,
  KernelGoneError,
  type ProcessEntry,
  type SpawnedProcess,
  type SpawnOptions,
} from './client/attach.ts';
export type {
  RunOptions,
  RunResult,
  Terminal,
  TerminalOptions,
  TerminalSignal,
} from './index.ts';
export { fetchTransport, type NetworkTransport } from './transport.ts';
export { memoryRoot };

export interface NodeKernelOptions {
  root?: FileSystemDirectoryHandle;
  modules?: string;
  env?: Record<string, string>;
  network?: { transport?: NetworkTransport };
  worker?: string | URL;
}

export interface NodeKernel {
  readonly root: FileSystemDirectoryHandle;
  run(argv: string[], options?: RunOptions): Promise<RunResult>;
  openTerminal(argv: string[], options?: TerminalOptions): Promise<Terminal>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  connect(): Promise<MessagePort>;
  terminate(): void;
}

export function nodeTransport(): NetworkTransport {
  const transport = fetchTransport();
  return { ...transport, traits: { ...transport.traits, crossOrigin: 'any' } };
}

const TERMINATED = 'the kernel is terminated';

function nodeWorker(file: string | URL, live: Set<() => void>, closed: boolean): WasmWorkerLike {
  const errors = new Set<(event: MessageEvent) => void>();
  const messages = new Map<(event: MessageEvent) => void, (data: unknown) => void>();
  const fail = (message: string) => {
    for (const handler of [...errors]) {
      handler({ message, preventDefault() {} } as unknown as MessageEvent);
    }
  };
  const worker = closed ? undefined : new Worker(file);
  if (worker) {
    const kill = () => {
      void worker.terminate();
      fail(TERMINATED);
    };
    live.add(kill);
    worker.once('exit', () => live.delete(kill));
    worker.on('error', (err) => fail(String(err)));
  } else {
    setTimeout(() => fail(TERMINATED), 0);
  }
  return {
    postMessage: (message, transfer) => worker?.postMessage(message, transfer as never),
    addEventListener(type, handler) {
      if (type === 'error') {
        errors.add(handler);
        return;
      }
      const listener = (data: unknown) => handler({ data } as MessageEvent);
      messages.set(handler, listener);
      worker?.on('message', listener);
    },
    removeEventListener(type, handler) {
      errors.delete(handler);
      const listener = messages.get(handler);
      if (listener) worker?.off('message', listener);
    },
    terminate: () => void worker?.terminate(),
  };
}

function textOf(on: ((text: string) => void) | undefined) {
  if (!on) return undefined;
  const decoder = new TextDecoder();
  return (bytes: Uint8Array) => on(decoder.decode(bytes, { stream: true }));
}

export async function createNodeKernel(options: NodeKernelOptions = {}): Promise<NodeKernel> {
  const root = options.root ?? memoryRoot();
  const fs = new OpfsFs(root);
  await fs.reconcile();
  const live = new Set<() => void>();
  const pending = new Set<(err: Error) => void>();
  const clients = new Set<ServedClient>();
  let terminated = false;
  const file = options.worker ?? new URL('./node-process-worker.js', import.meta.url);
  const transport = options.network?.transport;
  const launcher = new Launcher({
    fs,
    createWorker: () => nodeWorker(file, live, terminated),
    ...(options.modules ? { modules: options.modules } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(transport ? { transport } : {}),
  });
  await launcher.prepare();
  const guard = <T>(work: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (terminated) return reject(new Error(TERMINATED));
      pending.add(reject);
      work()
        .then(resolve, reject)
        .finally(() => pending.delete(reject));
    });
  const decoder = new TextDecoder();
  return {
    root,
    async run(argv, opts = {}) {
      const { stdin, onStdout, onStderr, ...rest } = opts;
      const onOut = textOf(onStdout);
      const onErr = textOf(onStderr);
      const result = await guard(() =>
        launcher.run(argv, {
          ...rest,
          ...(stdin !== undefined
            ? { stdin: typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin }
            : {}),
          ...(onOut ? { onStdout: onOut } : {}),
          ...(onErr ? { onStderr: onErr } : {}),
        })
      );
      return {
        status: result.status,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    },
    async openTerminal(argv, opts = {}) {
      const { onData, ...rest } = opts;
      let listener = onData ?? null;
      const backlog: Uint8Array[] = [];
      const session = await guard(() =>
        launcher.openTerminal(argv, {
          ...rest,
          onData: (bytes) => (listener ? listener(bytes) : backlog.push(bytes)),
        })
      );
      return {
        pid: session.pid,
        exited: guard(() => session.exited),
        get onData() {
          return listener;
        },
        set onData(next) {
          listener = next;
          if (next) for (const bytes of backlog.splice(0)) next(bytes);
        },
        write: (data) =>
          session.write(typeof data === 'string' ? new TextEncoder().encode(data) : data),
        resize: (cols, rows) => session.resize(cols, rows),
        signal: (name) => session.signal(signalNumber(name)),
        close: () => session.close(),
      };
    },
    async writeFile(path, data) {
      const parent = path.slice(0, path.lastIndexOf('/')) || '/';
      await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(path, data);
    },
    readFile: async (path) => fs.readFileBuffer(path),
    async connect() {
      if (terminated) throw new Error(TERMINATED);
      const { port1, port2 } = new MessageChannel();
      const served = serveClient(port1 as unknown as MessagePortLike, {
        launcher: async () => launcher,
        signal: signalNumber,
      });
      clients.add(served);
      void served.closed.then(() => clients.delete(served));
      return port2;
    },
    terminate() {
      terminated = true;
      for (const client of [...clients]) client.detach();
      for (const reject of [...pending]) reject(new Error(TERMINATED));
      for (const kill of [...live]) kill();
    },
  };
}
