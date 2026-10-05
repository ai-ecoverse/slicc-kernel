import type { KernelCall } from './serve.ts';

export interface KernelOptions {
  root?: FileSystemDirectoryHandle;
  modules?: string;
  env?: Record<string, string>;
  worker?: string | URL;
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
  terminate(): void;
}

interface Reply {
  id: number;
  result?: unknown;
  error?: string;
  fd?: 1 | 2;
  bytes?: Uint8Array;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  output?: (fd: 1 | 2, bytes: Uint8Array) => void;
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
    for (const call of pending.values()) call.reject(error);
    pending.clear();
  };
  worker.addEventListener('message', ({ data }: MessageEvent<Reply>) => {
    const call = pending.get(data.id);
    if (!call) return;
    if (data.fd !== undefined) return call.output?.(data.fd, data.bytes as Uint8Array);
    pending.delete(data.id);
    if (data.error !== undefined) call.reject(new Error(data.error));
    else call.resolve(data.result);
  });
  worker.addEventListener('error', (event) => {
    event.preventDefault();
    fail(new Error(`slicc-kernel worker failed: ${event.message}`));
  });

  function call(req: KernelCall, output?: Pending['output']): Promise<unknown> {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, ...(output ? { output } : {}) });
      worker.postMessage({ ...req, id });
    });
  }

  await call({
    op: 'init',
    ...(options.root ? { root: options.root } : {}),
    ...(options.modules ? { modules: options.modules } : {}),
    ...(options.env ? { env: options.env } : {}),
  });

  return {
    async run(argv, runOptions = {}) {
      const { onStdout, onStderr, stdin, ...rest } = runOptions;
      const streams = { 1: streamer(onStdout), 2: streamer(onStderr) };
      const input = typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin;
      const result = (await call(
        { op: 'run', argv, options: { ...rest, ...(input ? { stdin: input } : {}) } },
        (fd, bytes) => streams[fd](bytes)
      )) as { status: number; stdout: Uint8Array; stderr: Uint8Array };
      const decoder = new TextDecoder();
      return {
        status: result.status,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    },
    terminate() {
      fail(new Error('slicc-kernel terminated'));
      worker.terminate();
    },
  };
}
