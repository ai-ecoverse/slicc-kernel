import {
  DRIVER_PROTOCOL,
  type DriverAttr,
  type DriverCapabilities,
  type DriverEntry,
  type DriverOwner,
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
  DriverOwner,
  DriverStatfs,
  MountRequestInfo,
} from './protocol.ts';

import { fresh } from '../bytes.ts';

export interface OpenFlags {
  write: boolean;
  create: boolean;
  truncate: boolean;
  exclusive: boolean;
  ifMatch?: string;
  owner?: DriverOwner;
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
  mkdir(path: string, owner?: DriverOwner): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  link?(from: string, to: string): Promise<void>;
  symlink?(target: string, path: string, owner?: DriverOwner): Promise<void>;
  mkfifo?(path: string, owner?: DriverOwner): Promise<void>;
  readlink?(path: string): Promise<string>;
  setattr?(path: string, attr: DriverSetAttr): Promise<void>;
  statfs?(): Promise<DriverStatfs>;
}

export interface DriverSetAttr {
  mode?: number;
  mtime?: number;
  atime?: number;
  size?: number;
  uid?: number;
  gid?: number;
}

function ownerOf(req: DriverOwner): DriverOwner | undefined {
  const owner = {
    ...(req.uid !== undefined ? { uid: req.uid } : {}),
    ...(req.gid !== undefined ? { gid: req.gid } : {}),
    ...(req.mode !== undefined ? { mode: req.mode } : {}),
  };
  return Object.keys(owner).length > 0 ? owner : undefined;
}

function withOwner<T extends object>(base: T, owner: DriverOwner | undefined): T {
  return owner ? { ...base, owner } : base;
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

const SET_ATTRS = ['mode', 'mtime', 'atime', 'size', 'uid', 'gid'] as const;

function setAttrOf(req: DriverSetAttr): DriverSetAttr {
  const attr: DriverSetAttr = {};
  for (const key of SET_ATTRS) if (req[key] !== undefined) attr[key] = req[key];
  return attr;
}

async function dispatch(h: FilesystemHandlers, req: DriverRequest): Promise<unknown> {
  switch (req.op) {
    case 'getattr':
      return h.getattr(req.path);
    case 'readdir':
      return h.readdir(req.path);
    case 'open':
      return h.open(
        req.path,
        withOwner(
          {
            write: req.write,
            create: req.create,
            truncate: req.truncate,
            exclusive: req.exclusive,
            ...(req.ifMatch !== undefined ? { ifMatch: req.ifMatch } : {}),
          },
          ownerOf(req)
        )
      );
    case 'read':
      return h.read(req.fh, req.offset, req.size);
    case 'write':
      return h.write(req.fh, req.offset, req.bytes);
    case 'release':
      return h.release(req.fh);
    case 'mkdir':
      return ownerOf(req) ? h.mkdir(req.path, ownerOf(req)) : h.mkdir(req.path);
    case 'rmdir':
      return h.rmdir(req.path);
    case 'unlink':
      return h.unlink(req.path);
    case 'rename':
      return h.rename(req.from, req.to);
    case 'link':
      if (!h.link) throw fsError('EPERM', 'this file system has no hard links');
      return h.link(req.from, req.to);
    case 'mkfifo':
      if (!h.mkfifo) throw fsError('EPERM', 'this file system has no FIFOs');
      return ownerOf(req) ? h.mkfifo(req.path, ownerOf(req)) : h.mkfifo(req.path);
    case 'symlink':
      if (!h.symlink) throw fsError('EPERM', 'this file system has no symlinks');
      return ownerOf(req)
        ? h.symlink(req.target, req.path, ownerOf(req))
        : h.symlink(req.target, req.path);
    case 'readlink':
      if (!h.readlink) throw fsError('EINVAL', `${req.path} is not a symlink`);
      return h.readlink(req.path);
    case 'setattr':
      return h.setattr?.(req.path, setAttrOf(req));
    case 'statfs':
      return h.statfs?.() ?? null;
    default:
      throw fsError('ENOSYS', `unknown driver op ${(req as { op: string }).op}`);
  }
}

export function serveFilesystem(
  port: DriverPort,
  handlers: FilesystemHandlers,
  capabilities: DriverCapabilities = {},
  options: { owned?: boolean } = {}
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
          const whole = result.byteOffset === 0 && result.byteLength === result.buffer.byteLength;
          const bytes = options.owned && whole ? result : fresh(result);
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
