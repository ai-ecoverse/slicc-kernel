import type { TransportCall } from './kernel/net/remote-transport.ts';
import type { KernelCall, TerminalAction } from './serve.ts';
import { type NetworkTransport, serveTransport } from './transport.ts';

export {
  type LocalProxyOptions,
  type LocalProxyProbe,
  type LocalProxyTransportOptions,
  localProxyTransport,
  probeLocalProxy,
} from './local-proxy-transport.ts';
export {
  type FetchTransportOptions,
  fetchTransport,
  type HeaderList,
  type NetworkRequest,
  type NetworkResponse,
  type NetworkTraits,
  type NetworkTransport,
} from './transport.ts';

export interface NetworkOptions {
  transport?: NetworkTransport;
}

export interface KernelOptions {
  root?: FileSystemDirectoryHandle;
  modules?: string;
  env?: Record<string, string>;
  metadata?: string | false;
  worker?: string | URL;
  network?: NetworkOptions;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface Kernel {
  run(argv: string[], options?: RunOptions): Promise<RunResult>;
  openTerminal(argv: string[], options?: TerminalOptions): Promise<Terminal>;
  terminate(): void;
}

export interface TerminalOptions {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  onData?: (bytes: Uint8Array) => void;
}

export type TerminalSignal =
  | 'SIGINT'
  | 'SIGTSTP'
  | 'SIGQUIT'
  | 'SIGHUP'
  | 'SIGTERM'
  | 'SIGKILL'
  | 'SIGCONT';

export interface Terminal {
  readonly pid: number;
  readonly exited: Promise<number>;
  onData: ((bytes: Uint8Array) => void) | null;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  signal(name: TerminalSignal): void;
  close(): void;
}

interface Reply {
  id: number;
  result?: unknown;
  error?: string;
  fd?: 1 | 2;
  bytes?: Uint8Array;
  started?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  output?: (fd: 1 | 2, bytes: Uint8Array) => void;
  started?: (pid: number) => void;
}

interface Handlers {
  output?: Pending['output'];
  started?: Pending['started'];
}

const ISOLATION =
  'slicc-kernel needs a cross-origin isolated page (Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp or credentialless)';

function streamer(callback: ((text: string) => void) | undefined) {
  const decoder = new TextDecoder();
  return (bytes: Uint8Array) => callback?.(decoder.decode(bytes, { stream: true }));
}

export async function createKernel(options: KernelOptions = {}): Promise<Kernel> {
  if (!globalThis.crossOriginIsolated) throw new Error(ISOLATION);
  const url = options.worker ?? new URL('./kernel-worker.js', import.meta.url);
  const worker = new Worker(url, { type: 'module', name: 'slicc-kernel' });
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let failure: Error | undefined;

  const fail = (error: Error) => {
    failure = error;
    bridge?.close();
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  const transport = options.network?.transport;
  const bridge = transport ? serveTransport(worker, transport) : undefined;
  worker.addEventListener('message', ({ data }: MessageEvent<Reply | TransportCall>) => {
    if ('net' in data) return bridge?.answer(data);
    const call = pending.get(data.id);
    if (!call) return;
    if (data.fd !== undefined) return call.output?.(data.fd, data.bytes as Uint8Array);
    if (data.started !== undefined) return call.started?.(data.started);
    pending.delete(data.id);
    if (data.error !== undefined) call.reject(new Error(data.error));
    else call.resolve(data.result);
  });
  worker.addEventListener('error', (event) => {
    event.preventDefault();
    fail(new Error(`slicc-kernel worker failed: ${event.message}`));
  });

  function request(
    req: KernelCall,
    handlers: Handlers = {}
  ): { id: number; done: Promise<unknown> } {
    const id = ++nextId;
    if (failure) return { id, done: Promise.reject(failure) };
    const done = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, ...handlers });
      worker.postMessage({ ...req, id });
    });
    return { id, done };
  }

  const call = (req: KernelCall, handlers?: Handlers) => request(req, handlers).done;

  async function openTerminal(argv: string[], opts: TerminalOptions = {}): Promise<Terminal> {
    const { onData, ...options } = opts;
    let listener = onData ?? null;
    const backlog: Uint8Array[] = [];
    const started = Promise.withResolvers<number>();
    const { id, done } = request(
      { op: 'open-terminal', argv, options },
      {
        output: (_fd, bytes) => (listener ? listener(bytes) : backlog.push(bytes)),
        started: started.resolve,
      }
    );
    done.catch(started.reject);
    const pid = await started.promise;
    const send = (action: TerminalAction) =>
      void call({ op: 'terminal', terminal: id, ...action }).catch(() => undefined);
    return {
      pid,
      exited: done as Promise<number>,
      get onData() {
        return listener;
      },
      set onData(next) {
        listener = next;
        if (next) for (const bytes of backlog.splice(0)) next(bytes);
      },
      write: (data) =>
        send({
          action: 'write',
          bytes: typeof data === 'string' ? new TextEncoder().encode(data) : data,
        }),
      resize: (cols, rows) => send({ action: 'resize', cols, rows }),
      signal: (name) => send({ action: 'signal', signal: name }),
      close: () => send({ action: 'close' }),
    };
  }

  await call({
    op: 'init',
    ...(options.root ? { root: options.root } : {}),
    ...(options.modules ? { modules: options.modules } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    ...(transport ? { transport: transport.traits } : {}),
  });

  return {
    async run(argv, runOptions = {}) {
      const { onStdout, onStderr, stdin, ...rest } = runOptions;
      const streams = { 1: streamer(onStdout), 2: streamer(onStderr) };
      const input = typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin;
      const result = (await call(
        { op: 'run', argv, options: { ...rest, ...(input ? { stdin: input } : {}) } },
        { output: (fd, bytes) => streams[fd](bytes) }
      )) as { status: number; stdout: Uint8Array; stderr: Uint8Array };
      const decoder = new TextDecoder();
      return {
        status: result.status,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    },
    openTerminal,
    terminate() {
      fail(new Error('slicc-kernel terminated'));
      worker.terminate();
    },
  };
}
