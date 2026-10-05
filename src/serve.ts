import { OpfsFs } from './fs/opfs.ts';
import type { WasmWorkerLike } from './kernel/host.ts';
import { Launcher, type RunOptions } from './launcher.ts';

export interface KernelPort {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
}

export interface InitRequest {
  id: number;
  op: 'init';
  root?: FileSystemDirectoryHandle;
  modules?: string;
  env?: Record<string, string>;
}

export interface RunRequest {
  id: number;
  op: 'run';
  argv: string[];
  options: Omit<RunOptions, 'onStdout' | 'onStderr'>;
}

export type KernelRequest = InitRequest | RunRequest;

export type KernelCall = Omit<InitRequest, 'id'> | Omit<RunRequest, 'id'>;

export interface ServeDeps {
  storage: () => Promise<FileSystemDirectoryHandle>;
  createWorker: () => WasmWorkerLike;
}

export function serveKernel(port: KernelPort, deps: ServeDeps): void {
  let launcher: Promise<Launcher> | undefined;
  const reply = (id: number, body: object) => port.postMessage({ id, ...body });

  async function handle(req: KernelRequest): Promise<unknown> {
    if (req.op === 'init') {
      launcher = (req.root ? Promise.resolve(req.root) : deps.storage()).then(
        (root) =>
          new Launcher({
            fs: new OpfsFs(root),
            createWorker: deps.createWorker,
            ...(req.modules ? { modules: req.modules } : {}),
            ...(req.env ? { env: req.env } : {}),
          })
      );
      await launcher;
      return true;
    }
    if (!launcher) throw new Error('the kernel is not initialized');
    return (await launcher).run(req.argv, {
      ...req.options,
      onStdout: (bytes) => reply(req.id, { fd: 1, bytes }),
      onStderr: (bytes) => reply(req.id, { fd: 2, bytes }),
    });
  }

  port.addEventListener('message', (event) => {
    const req = event.data as KernelRequest;
    handle(req).then(
      (result) => reply(req.id, { result }),
      (err) => reply(req.id, { error: err instanceof Error ? err.message : String(err) })
    );
  });
}
