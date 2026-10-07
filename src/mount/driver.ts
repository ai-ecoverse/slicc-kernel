import {
  DRIVER_PROTOCOL,
  type DriverAttr,
  type DriverCapabilities,
  type DriverEntry,
  type DriverRequest,
  type DriverStatfs,
  driverVersionError,
  type KernelDriverHello,
  type MountRequestInfo,
} from './protocol.ts';

export type {
  DriverAttr,
  DriverCapabilities,
  DriverEntry,
  DriverStatfs,
  MountRequestInfo,
} from './protocol.ts';

export interface OpenFlags {
  write: boolean;
  create: boolean;
  truncate: boolean;
  exclusive: boolean;
}

export interface FilesystemHandlers {
  mount?(
    info: MountRequestInfo
  ): Promise<DriverCapabilities | undefined> | DriverCapabilities | undefined;
  getattr(path: string): Promise<DriverAttr>;
  readdir(path: string): Promise<DriverEntry[]>;
  open(path: string, flags: OpenFlags): Promise<number>;
  read(fh: number, offset: number, size: number): Promise<Uint8Array>;
  write(fh: number, offset: number, bytes: Uint8Array): Promise<void>;
  release(fh: number): Promise<void>;
  mkdir(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  symlink?(target: string, path: string): Promise<void>;
  readlink?(path: string): Promise<string>;
  setattr?(path: string, attr: { mode?: number; mtime?: number }): Promise<void>;
  statfs?(): Promise<DriverStatfs>;
}

export interface DriverPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent) => void): void;
  start?(): void;
}

export interface ServedFilesystem {
  invalidate(paths: string[] | true): void;
}

export function fsError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function dispatch(h: FilesystemHandlers, req: DriverRequest): Promise<unknown> {
  switch (req.op) {
    case 'getattr':
      return h.getattr(req.path);
    case 'readdir':
      return h.readdir(req.path);
    case 'open':
      return h.open(req.path, {
        write: req.write,
        create: req.create,
        truncate: req.truncate,
        exclusive: req.exclusive,
      });
    case 'read':
      return h.read(req.fh, req.offset, req.size);
    case 'write':
      return h.write(req.fh, req.offset, req.bytes);
    case 'release':
      return h.release(req.fh);
    case 'mkdir':
      return h.mkdir(req.path);
    case 'rmdir':
      return h.rmdir(req.path);
    case 'unlink':
      return h.unlink(req.path);
    case 'rename':
      return h.rename(req.from, req.to);
    case 'symlink':
      if (!h.symlink) throw fsError('EPERM', 'this file system has no symlinks');
      return h.symlink(req.target, req.path);
    case 'readlink':
      if (!h.readlink) throw fsError('EINVAL', `${req.path} is not a symlink`);
      return h.readlink(req.path);
    case 'setattr':
      return h.setattr?.(req.path, {
        ...(req.mode !== undefined ? { mode: req.mode } : {}),
        ...(req.mtime !== undefined ? { mtime: req.mtime } : {}),
      });
    case 'statfs':
      return h.statfs?.() ?? null;
    default:
      throw fsError('ENOSYS', `unknown driver op ${(req as { op: string }).op}`);
  }
}

export function serveFilesystem(
  port: DriverPort,
  handlers: FilesystemHandlers,
  capabilities: DriverCapabilities = {}
): ServedFilesystem {
  let open = false;
  const reply = (message: object, transfer: Transferable[] = []) =>
    port.postMessage(message, transfer);
  async function hello(message: KernelDriverHello): Promise<void> {
    const refused = driverVersionError(message.protocol);
    if (refused) {
      reply({ hello: { protocol: DRIVER_PROTOCOL, error: refused, errno: 'EPROTO' } });
      return;
    }
    try {
      const refined = await handlers.mount?.(message.mount);
      open = true;
      reply({
        hello: { protocol: DRIVER_PROTOCOL, capabilities: { ...capabilities, ...refined } },
      });
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      reply({
        hello: {
          protocol: DRIVER_PROTOCOL,
          error: err instanceof Error ? err.message : String(err),
          errno: typeof code === 'string' ? code : 'EIO',
        },
      });
    }
  }
  port.addEventListener('message', (event) => {
    const data = event.data as { hello?: KernelDriverHello } & DriverRequest;
    if (data.hello) {
      void hello(data.hello);
      return;
    }
    if (!open) return;
    dispatch(handlers, data).then(
      (result) => {
        if (result instanceof Uint8Array) {
          const bytes = result.slice();
          reply({ id: data.id, result: bytes }, [bytes.buffer]);
        } else reply({ id: data.id, result: result ?? null });
      },
      (err: unknown) => {
        const code = (err as { code?: unknown })?.code;
        reply({
          id: data.id,
          errno: typeof code === 'string' ? code : 'EIO',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    );
  });
  port.start?.();
  return { invalidate: (paths) => reply({ invalidate: paths }) };
}
