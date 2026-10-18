import type { HeldMeta, PollState } from '../kernel/fd-table.ts';
import type { MountLine, ProcessListing } from '../kernel/proc-info.ts';
import type { Termios } from '../kernel/tty.ts';
import type { EmscriptenFsForHook } from '../realm/emscripten-vfs-hook.ts';
import { useKernelFdMetadata } from './fd-metadata.ts';
import { wasiErrno } from './wasi-errno.ts';

const POLLIN = 0x001;
const POLLOUT = 0x004;
const POLLERR = 0x008;
const POLLHUP = 0x010;
const POLLRDNORM = 0x040;
const POLLWRNORM = 0x100;
const TCSETSF = 0x5404;

export const O_NONBLOCK = 0o4000;
const SOCKET_MODE = 0o140777;

interface PtyPathFs {
  chown?: (path: string, ...rest: number[]) => void;
  lchown?: (path: string, ...rest: number[]) => void;
  chmod?: (path: string, ...rest: number[]) => void;
  lchmod?: (path: string, ...rest: number[]) => void;
  stat?: (path: string, ...rest: unknown[]) => unknown;
  lstat?: (path: string, ...rest: unknown[]) => unknown;
}

const PTY_PATH = /^\/dev\/(?:ptmx|pts\/(\d+))$/;

const TTY_PATH = /^\/dev\/tty\d+$/;

const PTS_MAJOR = 136;

interface TtyNodeFs {
  analyzePath?: (path: string) => { exists: boolean };
  mkdev?: (path: string, dev: number) => unknown;
  makedev?: (major: number, minor: number) => number;
  registerDevice?: (dev: number, ops: object) => void;
}

interface DevDirFs extends TtyNodeFs {
  mkdir?: (path: string, mode?: number) => unknown;
  lookupNode?: (parent: object, name: string) => object;
  readdir?: (path: string) => string[];
  getPath?: (node: object) => string;
  lookupPath?: (path: string, opts: { follow: boolean }) => { path: string };
  cwd?: () => string;
}

const TTY_NAME = /^tty\d+$/;

function isPtyPath(path: string): boolean {
  return PTY_PATH.test(path);
}

function ptyStat(path: string): object {
  const n = PTY_PATH.exec(path)?.[1];
  const now = new Date();
  return {
    dev: 0x16,
    ino: n === undefined ? 2 : 3 + Number(n),
    mode: n === undefined ? 0o20666 : 0o20620,
    nlink: 1,
    uid: 1000,
    gid: 1000,
    rdev: n === undefined ? (5 << 8) | 2 : (136 << 8) | Number(n),
    size: 0,
    blksize: 4096,
    blocks: 0,
    atime: now,
    mtime: now,
    ctime: now,
  };
}

const SEALED_PATH = '/dev/sealed';

const STRERROR: Readonly<Record<string, string>> = {
  EACCES: 'Permission denied',
  EIO: 'I/O error',
  ENOTSUP: 'Not supported',
  EOPNOTSUPP: 'Not supported',
  EFBIG: 'File too large',
  EILSEQ: 'Illegal byte sequence',
  EINTR: 'Interrupted system call',
};
const CLIPBOARD_PATH = '/dev/clipboard';

function sealedStat(minor = 250): object {
  const now = new Date();
  return {
    dev: 0x16,
    ino: minor === 251 ? 2 : 1,
    mode: 0o20666,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: (10 << 8) | minor,
    size: 0,
    blksize: 4096,
    blocks: 0,
    atime: now,
    mtime: now,
    ctime: now,
  };
}

const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_NOCTTY = 0o400;
const O_TRUNC = 0o1000;
const O_DIRECTORY = 0o200000;

const KILLED_BY_SIGPIPE = 128 + 13;

export class ProcessExit extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`exit ${status}`);
    this.status = status;
  }
}

export class SyscallError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface ReadOptions {
  nonblock?: boolean;
  peek?: boolean;
}

export interface ProcessSys {
  read(fd: number, max: number, opts?: ReadOptions): Uint8Array;

  write(fd: number, bytes: Uint8Array, opts?: { nonblock?: boolean }): number;
  close(fd: number): void;

  pipe(): [number, number];
  poll(fd: number): PollState;

  openVfs(
    path: string,
    flags: number,
    position: number,
    opts?: {
      contents?: Uint8Array;
      orphan?: boolean;
      truncate?: boolean;
      create?: boolean;
      created?: boolean;
      pin?: { version: string; size: number };
      handle?: number;
      ino?: number;
      fifo?: boolean;
    }
  ): number;

  seek(fd: number, offset: number, whence: number): number;

  flush(fd: number): void;

  pread?(fd: number, max: number, at: number): Uint8Array;

  pwrite?(fd: number, bytes: Uint8Array, at: number): number;

  isatty?(fd: number): boolean;

  ttyName?(fd: number): string | undefined;

  kind?(fd: number): string | undefined;

  heldMeta?(fd: number): HeldMeta | undefined;

  access?(fd: number): 'read' | 'write' | undefined;

  size?(fd: number): number;
  fdStat?(fd: number): object | undefined;
  fdChmod?(fd: number, mode: number): void;
  fdChown?(fd: number, uid: number | undefined, gid: number | undefined): void;
  fdUtimes?(fd: number, atimeMs: number | null, mtimeMs: number | null, now: boolean): void;

  openTty?(name?: string): number;
  ttyNames?(): string[];
  ttyOwner?(name: string): TtyOwner | null;

  tcgets?(fd: number): Termios;
  tcsets?(fd: number, termios: Termios, flush?: boolean): void;
  winsize?(fd: number): [number, number];

  openPty?(): number;
  openPts?(n: number, noctty: boolean): number;

  ptyNumbers?(): number[];

  openSealed?(flags: number): number;
  openClipboard?(flags: number): number;
  clipboardAbort?(fd: number): void;
  procList?(): ProcessListing;
  mountList?(): MountLine[];
}

export interface StreamOps {
  getattr?: (stream: ProcessStream) => object;
  llseek?: (stream: ProcessStream, offset: number, whence: number) => number;
  read?: (stream: ProcessStream, buffer: Uint8Array, offset: number, length: number) => number;
  write?: (stream: ProcessStream, buffer: Uint8Array, offset: number, length: number) => number;
  close?: (stream: ProcessStream) => void;
  dup?: (stream: ProcessStream) => void;
  poll?: (stream: ProcessStream) => number;
  fsync?: (stream: ProcessStream) => unknown;
  mmap?: unknown;
}

export interface ProcessStream {
  fd: number;
  stream_ops: StreamOps;
  sliccKernelFd?: number;

  sliccKernelFile?: boolean;

  sliccCloexec?: boolean;

  sliccKernelSocket?: boolean;
  sliccKernelFifo?: string;
  path?: string;
  flags: number;
  position: number;
  tty?: unknown;
  node: {
    mode: number;
    mount?: { type?: unknown };
    node_ops?: { getattr?: (node: ProcessStream['node']) => object };
  };

  shared: object;
}

export interface ProcessFs extends EmscriptenFsForHook {
  streams: (ProcessStream | null | undefined)[];
  getStream(fd: number): ProcessStream | null;
  open(path: string, flags: number, mode?: number): ProcessStream;
  dupStream(stream: ProcessStream, fd: number): ProcessStream;
  closeStream(fd: number): void;

  close?(stream: ProcessStream): void;
  isFile(mode: number): boolean;
  mkdirTree(path: string): void;
  cwd(): string;
  read(
    stream: ProcessStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position?: number
  ): number;
  write(stream: ProcessStream, buffer: Uint8Array, offset: number, length: number): number;

  stat?(path: string, dontFollow?: boolean): object;
  writeFile?(path: string, data: string | Uint8Array): void;
  fstat?(fd: number): object;
  symlink?(target: string, path: string): void;
  lookupPath?(path: string, opts?: { follow?: boolean }): { node: object };
}

interface FsNode {
  mode: number;
  node_ops: object;
}

interface SocketNodeFs {
  mount(type: { mount(): FsNode }, opts: object, mountpoint: null): FsNode;
  createNode(parent: FsNode | null, name: string, mode: number, rdev: number): FsNode;
  createStream(stream: object, fd?: number): ProcessStream;
}

export interface ProcessPipeFs {
  createPipe(): { readable_fd: number; writable_fd: number };
}

export interface KernelStreamOptions {
  sigpipe?: () => boolean;

  restartable?: () => boolean;
  owners?: boolean;
  program?: string;
}

export interface TtyOwner {
  uid: number;
  gid: number;
  mode?: number;
}

function nonblocking(stream: ProcessStream): { nonblock: true } | undefined {
  return (stream.flags & O_NONBLOCK) !== 0 ? { nonblock: true } : undefined;
}

function datesOf(real: object | undefined): Record<string, Date> {
  const dates: Record<string, Date> = {};
  for (const [key, value] of Object.entries(real ?? {}))
    if (/^[amc]time$/.test(key) && (typeof value === 'string' || typeof value === 'number'))
      dates[key] = new Date(value);
  return dates;
}

export class KernelStreams {
  private readonly refs = new Map<number, number>();

  private socketRoot: FsNode | undefined;

  private sockets = 0;

  private readonly descriptions = new Map<string, () => object>();

  private described = 0;

  private readonly Fs: ProcessFs;

  private readonly sys: ProcessSys;

  private readonly options: KernelStreamOptions;

  constructor(
    Fs: ProcessFs,

    sys: ProcessSys,

    options: KernelStreamOptions = {}
  ) {
    this.Fs = Fs;

    this.sys = sys;

    this.options = options;
  }

  attach(stream: ProcessStream, kfd: number, terminal?: boolean): void {
    this.refs.set(kfd, (this.refs.get(kfd) ?? 0) + 1);

    stream.sliccKernelFd = kfd;
    stream.stream_ops = this.ops(kfd, stream.stream_ops);
    if (terminal ?? this.sys.isatty?.(kfd) ?? false) stream.tty = this.ttyOps(kfd);
    else delete stream.tty;
  }

  attachFifo(stream: ProcessStream, path: string): void {
    const kfd = this.call(() =>
      this.restarting(() => this.sys.openVfs(path, stream.flags, 0, { fifo: true }))
    );
    this.attach(stream, kfd, false);
    stream.sliccKernelFifo = path;
  }

  attachSocket(stream: ProcessStream, kfd: number): void {
    this.attach(stream, kfd, false);
    stream.sliccKernelSocket = true;
  }

  socketStream(flags: number): ProcessStream {
    const fs = this.Fs as unknown as Partial<SocketNodeFs>;
    if (!fs.mount || !fs.createNode || !fs.createStream) {
      const stream = this.Fs.open('/dev/null', 2);
      stream.flags = flags;
      return stream;
    }
    const createNode = fs.createNode;
    this.socketRoot ??= fs.mount({ mount: () => createNode(null, '/', 0o40777, 0) }, {}, null);
    const ino = ++this.sockets;
    const node = fs.createNode(this.socketRoot, `socket:${ino}`, SOCKET_MODE, 0);
    const now = new Date();
    const stat = { dev: 0, ino, mode: SOCKET_MODE, nlink: 1, uid: 0, gid: 0, rdev: 0, size: 0 };
    const times = { atime: now, mtime: now, ctime: now, blksize: 4096, blocks: 0 };
    node.node_ops = { getattr: () => ({ ...stat, ...times }) };
    return fs.createStream({ node, flags, seekable: false, position: 0, stream_ops: {} });
  }

  nameTerminal(stream: ProcessStream): void {
    const kfd = stream.sliccKernelFd;
    if (!stream.tty || kfd === undefined) return;
    const name = this.sys.ttyName?.(kfd);
    if (name) this.nameStream(stream, name);
  }

  private nameStream(stream: ProcessStream, name: string): void {
    stream.path = name;
    this.ttyNode(name);
    if (typeof this.Fs.stat !== 'function') return;

    stream.stream_ops = { ...stream.stream_ops, getattr: () => this.Fs.stat?.(name) ?? {} };
  }

  nameDevice(stream: ProcessStream, kind: 'sealed' | 'clipboard'): void {
    this.nameStream(stream, kind === 'sealed' ? SEALED_PATH : CLIPBOARD_PATH);
  }

  private listSealed(): void {
    const fs = this.Fs as unknown as TtyNodeFs;
    const { analyzePath, mkdev, makedev, registerDevice } = fs;
    if (!analyzePath || !mkdev || !makedev) return;
    const nodes: Array<[string, number, ((flags: number) => number) | undefined]> = [
      [SEALED_PATH, 250, this.sys.openSealed],
      [CLIPBOARD_PATH, 251, this.sys.openClipboard],
    ];
    for (const [path, minor, opener] of nodes) {
      if (!opener) continue;
      const dev = makedev.call(fs, 10, minor);
      registerDevice?.call(fs, dev, {
        open: (stream: ProcessStream) => this.openNode(stream, path, opener),
      });
      if (analyzePath.call(fs, path).exists) continue;
      try {
        const node = mkdev.call(fs, path, dev);
        if (typeof node === 'object' && node !== null) {
          const made = node as { node_ops?: object };
          made.node_ops = { ...made.node_ops, getattr: () => sealedStat(minor) };
        }
      } catch {}
    }
  }

  private openNode(stream: ProcessStream, path: string, opener: (flags: number) => number): void {
    let kfd: number;
    try {
      kfd = this.call(() => opener.call(this.sys, stream.flags & 3));
    } catch (e) {
      this.Fs.closeStream(stream.fd);
      throw e;
    }
    this.attach(stream, kfd, false);
    this.nameStream(stream, path);
    if (path === CLIPBOARD_PATH) this.reportClose(kfd);
  }

  private readonly reporting = new Set<number>();

  reportClose(kfd: number): void {
    this.reporting.add(kfd);
  }

  quitting = false;

  private atExit = false;

  private failedAtExit = false;

  private readonly committed = new Set<number>();

  exiting(): () => void {
    this.atExit = true;
    return () => {
      this.atExit = false;
    };
  }

  private commitStdout(): void {
    const kfd = this.Fs.getStream(1)?.sliccKernelFd;
    if (kfd === undefined || !this.reporting.delete(kfd)) return;
    this.committed.add(kfd);
    try {
      this.sys.close(kfd);
    } catch (e) {
      if (e instanceof SyscallError) this.stdoutFailed(e.code);
    }
  }

  exitStatus(status: number): number {
    return this.failedAtExit && status === 0 ? 1 : status;
  }

  private reportedClose(stream: ProcessStream, kfd: number): void {
    try {
      this.sys.close(kfd);
    } catch (e) {
      if (this.quitting && stream.fd === 1 && e instanceof SyscallError) this.stdoutFailed(e.code);
      this.call(() => {
        throw e;
      });
    }
  }

  private stdoutFailed(code: string): void {
    this.failedAtExit = true;
    const stderr = this.Fs.getStream(2)?.sliccKernelFd;
    if (stderr === undefined) return;
    const line = `${this.options.program ?? 'program'}: write error: ${STRERROR[code] ?? code}\n`;
    try {
      this.sys.write(stderr, new TextEncoder().encode(line));
    } catch {}
  }

  private creatingTerminal = false;

  private useTerminalNodes(): void {
    const fs = this.Fs as unknown as DevDirFs;
    const { lookupNode, readdir, getPath, mkdev, makedev } = fs;
    const ttyNames = this.sys.ttyNames?.bind(this.sys);
    if (!lookupNode || !readdir || !getPath || !mkdev || !makedev || !ttyNames) return;
    fs.lookupNode = (parent, name) => {
      try {
        return lookupNode.call(fs, parent, name);
      } catch (e) {
        const path = `/dev/${name}`;
        if (this.creatingTerminal || !TTY_NAME.test(name) || getPath.call(fs, parent) !== '/dev')
          throw e;
        if (!ttyNames().includes(path)) throw e;
        this.creatingTerminal = true;
        try {
          mkdev.call(fs, path, makedev.call(fs, 6, 0));
        } finally {
          this.creatingTerminal = false;
        }
        return lookupNode.call(fs, parent, name);
      }
    };
    fs.readdir = (path) => {
      const names = readdir.call(fs, path);
      if (path.replace(/\/+$/, '') !== '/dev') return names;
      const missing = ttyNames()
        .map((tty) => tty.slice('/dev/'.length))
        .filter((name) => TTY_NAME.test(name) && !names.includes(name));
      return [...names, ...missing];
    };
  }

  private usePtsNodes(): void {
    const fs = this.Fs as unknown as DevDirFs;
    const { lookupNode, readdir, getPath, mkdir, mkdev, makedev } = fs;
    const numbers = this.sys.ptyNumbers?.bind(this.sys);
    if (!lookupNode || !readdir || !getPath || !mkdir || !mkdev || !makedev || !numbers) return;
    const make = (parent: object, name: string): boolean => {
      const dir = getPath.call(fs, parent);
      if (dir === '/dev' && name === 'pts') mkdir.call(fs, '/dev/pts', 0o755);
      else if (dir === '/dev/pts' && numbers().includes(Number(name)) && /^\d+$/.test(name))
        mkdev.call(fs, `/dev/pts/${name}`, makedev.call(fs, PTS_MAJOR, Number(name)));
      else return false;
      return true;
    };
    fs.lookupNode = (parent, name) => {
      try {
        return lookupNode.call(fs, parent, name);
      } catch (e) {
        if (this.creatingTerminal) throw e;
        this.creatingTerminal = true;
        let made: boolean;
        try {
          made = make(parent, name);
        } finally {
          this.creatingTerminal = false;
        }
        if (!made) throw e;
        return lookupNode.call(fs, parent, name);
      }
    };
    fs.readdir = (path) => {
      const at = path.replace(/\/+$/, '');
      if (at === '/dev/pts') return ['.', '..', ...numbers().map(String)];
      const names = readdir.call(fs, path);
      return at === '/dev' && !names.includes('pts') ? [...names, 'pts'] : names;
    };
  }

  private ptsTarget(path: string, st: unknown): string | undefined {
    if (((st as { rdev?: number } | null)?.rdev ?? 0) < PTS_MAJOR << 8) return undefined;
    const { lookupPath } = this.Fs as unknown as DevDirFs;
    const real = lookupPath?.call(this.Fs, path, { follow: true }).path;
    return real !== undefined && isPtyPath(real) ? real : undefined;
  }

  private ttyNode(name: string): void {
    const { analyzePath, mkdev, makedev } = this.Fs as unknown as TtyNodeFs;
    if (!TTY_PATH.test(name) || !analyzePath || !mkdev || !makedev) return;
    if (!analyzePath.call(this.Fs, name).exists)
      mkdev.call(this.Fs, name, makedev.call(this.Fs, 6, 0));
  }

  private ttyOps(kfd: number): object {
    return {
      ops: {
        ioctl_tcgets: () => this.call(() => this.sys.tcgets?.(kfd)),
        ioctl_tcsets: (_tty: unknown, op: number, termios: Termios) =>
          this.call(() => {
            this.sys.tcsets?.(kfd, termios, op === TCSETSF);
            return 0;
          }),
        ioctl_tiocgwinsz: () => this.call(() => this.sys.winsize?.(kfd) ?? [24, 80]),
        fsync: () => {},
      },
    };
  }

  attachFile(stream: ProcessStream, kfd: number): void {
    this.attach(stream, kfd, false);
    stream.sliccKernelFile = true;
    stream.stream_ops = {
      ...stream.stream_ops,
      llseek: (_s, offset, whence) => this.call(() => this.sys.seek(kfd, offset, whence)),

      fsync: () =>
        this.call(() => {
          this.sys.flush(kfd);
          return 0;
        }),
    };
  }

  sizeFromKernel(stream: ProcessStream, kfd: number): void {
    const getattr = this.kernelAttrs(stream, kfd);
    if (getattr) this.describe(stream, `${stream.path ?? ''}:${++this.described}`, getattr);
  }

  fstatFromKernel(stream: ProcessStream, kfd: number): void {
    const getattr = this.kernelAttrs(stream, kfd);
    if (getattr) stream.stream_ops = { ...stream.stream_ops, getattr };
  }

  private kernelAttrs(stream: ProcessStream, kfd: number): (() => object) | undefined {
    const { size, fdStat } = this.sys;
    if (!size) return undefined;
    const node = stream.node;
    return () => {
      const base = node.node_ops?.getattr?.(node);
      const live = this.call(() => size.call(this.sys, kfd));
      const real = fdStat && this.call(() => fdStat.call(this.sys, kfd));
      return { ...base, ...real, ...datesOf(real), size: live };
    };
  }

  describe(stream: ProcessStream, name: string, getattr: () => object): void {
    if (this.descriptions.size === 0) this.useDescriptions();
    this.descriptions.set(name, getattr);
    stream.path = name;
    stream.stream_ops = { ...stream.stream_ops, getattr };
  }

  private useDescriptions(): void {
    const fs = this.Fs as unknown as PtyPathFs;
    for (const name of ['stat', 'lstat'] as const) {
      const original = fs[name];
      if (typeof original !== 'function') continue;
      fs[name] = (path: string, ...rest: unknown[]) => {
        const getattr = this.descriptions.get(path);
        return getattr ? getattr() : original.call(fs, path, ...rest);
      };
    }
  }

  useKernelFdMetadata(): void {
    useKernelFdMetadata(this.Fs, this.sys, this.call.bind(this));
  }

  useControllingTerminal(): void {
    if (typeof this.Fs.open !== 'function') return;
    this.usePtyPaths();
    this.useTerminalNodes();
    this.usePtsNodes();
    this.listSealed();
    const open = this.Fs.open.bind(this.Fs);
    this.Fs.open = (path, flags, mode) => {
      const device = typeof path === 'string' ? this.devicePath(path) : undefined;
      if (device !== undefined && TTY_PATH.test(device) && !this.terminalExists(device)) {
        throw new this.Fs.ErrnoError(wasiErrno('ENOENT'));
      }
      const pty =
        this.openPty(open, path, flags, mode) ??
        this.openSealed(open, path, flags, mode) ??
        this.openClipboard(open, path, flags, mode);
      if (pty) return pty;
      this.refuseExclusiveLink(path, flags);
      const stream = this.openRacing(open, path, flags, mode);

      if (!stream.tty) return stream;
      if (stream.path === '/dev/tty' && this.sys.openTty) {
        let kfd: number;
        try {
          kfd = this.call(() => this.sys.openTty?.() as number);
        } catch (e) {
          this.Fs.closeStream(stream.fd);
          throw e;
        }
        this.attach(stream, kfd, true);
        return stream;
      }

      let named: number | undefined;
      try {
        named = stream.path ? this.openNamedTerminal(stream.path) : undefined;
      } catch (e) {
        this.Fs.closeStream(stream.fd);
        throw e;
      }
      if (named !== undefined) {
        this.attach(stream, named, true);
        return stream;
      }

      const terminal = this.stdioTerminal();
      if (terminal !== undefined) this.attach(stream, terminal, true);
      return stream;
    };
  }

  private openRacing(
    open: NonNullable<ProcessFs['open']>,
    path: string,
    flags: number,
    mode?: number
  ): ProcessStream {
    try {
      return open(path, flags, mode);
    } catch (err) {
      const lost = (err as { errno?: number }).errno === wasiErrno('EEXIST') && !(flags & O_EXCL);
      if (!lost) throw err;
      return open(path, flags, mode);
    }
  }

  private refuseExclusiveLink(path: string, flags: number): void {
    if ((flags & (O_CREAT | O_EXCL)) !== (O_CREAT | O_EXCL)) return;
    let mode = 0;
    try {
      mode = (this.Fs.stat?.(path, true) as { mode?: number } | undefined)?.mode ?? 0;
    } catch {}
    if ((mode & 0o170000) === 0o120000) throw new this.Fs.ErrnoError(wasiErrno('EEXIST'));
  }

  private openPty(
    open: NonNullable<ProcessFs['open']>,
    path: string,
    flags: number,
    mode?: number
  ): ProcessStream | undefined {
    const pts = /^\/dev\/pts\/(\d+)$/.exec(path);
    if (path !== '/dev/ptmx' && !pts) return undefined;
    const { openPty, openPts } = this.sys;
    if (!openPty || !openPts) return undefined;
    const kfd = this.call(() =>
      pts ? openPts(Number(pts[1]), (flags & O_NOCTTY) !== 0) : openPty()
    ) as number;
    return this.vessel(open, kfd, { path, flags, mode }, true);
  }

  private openSealed(
    open: NonNullable<ProcessFs['open']>,
    path: string,
    flags: number,
    mode?: number
  ): ProcessStream | undefined {
    const { openSealed } = this.sys;
    if (path !== SEALED_PATH || !openSealed) return undefined;
    const kfd = this.call(() => openSealed.call(this.sys, flags & 3));
    return this.vessel(open, kfd, { path, flags, mode }, false);
  }

  private openClipboard(
    open: NonNullable<ProcessFs['open']>,
    path: string,
    flags: number,
    mode?: number
  ): ProcessStream | undefined {
    const { openClipboard } = this.sys;
    if (path !== CLIPBOARD_PATH || !openClipboard) return undefined;
    if (flags & O_DIRECTORY) throw new this.Fs.ErrnoError(wasiErrno('ENOTDIR'));
    const kfd = this.call(() => openClipboard.call(this.sys, flags & 3));
    try {
      const stream = this.vessel(open, kfd, { path, flags, mode }, false);
      this.reportClose(kfd);
      return stream;
    } catch (e) {
      this.sys.clipboardAbort?.(kfd);
      this.sys.close(kfd);
      throw e;
    }
  }

  private vessel(
    open: NonNullable<ProcessFs['open']>,
    kfd: number,
    at: { path: string; flags: number; mode: number | undefined },
    terminal: boolean
  ): ProcessStream {
    let stream: ProcessStream;
    try {
      stream = open('/dev/null', at.flags & ~(O_CREAT | O_EXCL | O_TRUNC), at.mode);
    } catch (e) {
      this.sys.close(kfd);
      throw e;
    }

    this.attach(stream, kfd, terminal);

    this.nameStream(stream, at.path);
    return stream;
  }

  private usePtyPaths(): void {
    const fs = this.Fs as unknown as PtyPathFs;
    for (const name of ['chown', 'lchown', 'chmod', 'lchmod'] as const) {
      const original = fs[name];
      if (typeof original !== 'function') continue;
      fs[name] = (path: string, ...rest: number[]) =>
        isPtyPath(path) ? this.existingPty(path) : original.call(fs, path, ...rest);
    }
    for (const name of ['stat', 'lstat'] as const) {
      const original = fs[name];
      if (typeof original !== 'function') continue;
      fs[name] = (path: string, ...rest: unknown[]) => {
        if (path === SEALED_PATH && this.sys.openSealed) return sealedStat();
        if (path === CLIPBOARD_PATH && this.sys.openClipboard) return sealedStat(251);
        const owned = this.ownedTty(path);
        if (owned && isPtyPath(path)) return this.owned(path, ptyStat(path));
        if (!isPtyPath(path))
          return this.pathStat(path, original.call(fs, path, ...rest), name, owned);
        this.existingPty(path);
        return ptyStat(path);
      };
    }
  }

  private pathStat(path: string, st: unknown, name: 'stat' | 'lstat', owned: boolean): unknown {
    const pts = name === 'stat' ? this.ptsTarget(path, st) : undefined;
    if (pts) {
      this.existingPty(pts);
      return owned ? this.owned(pts, ptyStat(pts)) : ptyStat(pts);
    }
    return owned && TTY_PATH.test(path) ? this.owned(path, st as object) : st;
  }

  private ownedTty(path: string): boolean {
    return this.options.owners === true && this.sys.ttyOwner !== undefined && path !== '/dev/ptmx';
  }

  private owned(path: string, st: object): object {
    const ask = this.sys.ttyOwner as (name: string) => TtyOwner | null;
    const owner = this.call(() => ask.call(this.sys, path));
    if (!owner) return st;
    const mode = ((st as { mode: number }).mode & ~0o7777) | (owner.mode ?? 0o620);
    return { ...st, uid: owner.uid, gid: owner.gid, mode };
  }

  private existingPty(path: string): void {
    const n = PTY_PATH.exec(path)?.[1];
    const exists =
      n === undefined
        ? this.sys.openPty !== undefined
        : (this.sys.ptyNumbers?.().includes(Number(n)) ?? false);
    if (!exists) throw new this.Fs.ErrnoError(wasiErrno('ENOENT'));
  }

  private devicePath(path: string): string | undefined {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!TTY_NAME.test(name)) return undefined;
    const { lookupPath, cwd } = this.Fs as unknown as DevDirFs;
    const absolute = path.startsWith('/') ? path : `${cwd?.call(this.Fs) ?? '/'}/${path}`;
    const dir = absolute.slice(0, absolute.lastIndexOf('/')) || '/';
    try {
      const real = lookupPath?.call(this.Fs, dir, { follow: true }).path ?? dir;
      return `${real === '/' ? '' : real}/${name}`;
    } catch {
      return absolute;
    }
  }

  private terminalExists(path: string): boolean {
    const { analyzePath } = this.Fs as unknown as TtyNodeFs;
    return analyzePath?.call(this.Fs, path).exists ?? true;
  }

  private openNamedTerminal(path: string): number | undefined {
    const { openTty } = this.sys;
    if (!openTty) return undefined;
    try {
      return openTty.call(this.sys, path);
    } catch (e) {
      if (e instanceof SyscallError && e.code === 'ENXIO') return undefined;
      return this.call(() => {
        throw e;
      });
    }
  }

  private stdioTerminal(): number | undefined {
    for (const fd of [0, 1, 2]) {
      const stream = this.Fs.getStream(fd);
      if (stream?.sliccKernelFd !== undefined && stream.tty) return stream.sliccKernelFd;
    }
    return undefined;
  }

  usePipes(pipefs: ProcessPipeFs): void {
    const createPipe = pipefs.createPipe.bind(pipefs);
    pipefs.createPipe = () => {
      const [read, write] = this.call(() => this.sys.pipe());

      let fds: ReturnType<ProcessPipeFs['createPipe']>;
      try {
        fds = createPipe();
      } catch (e) {
        for (const kfd of [read, write]) {
          try {
            this.sys.close(kfd);
          } catch {}
        }
        throw e;
      }
      this.attach(this.Fs.getStream(fds.readable_fd) as ProcessStream, read, false);
      this.attach(this.Fs.getStream(fds.writable_fd) as ProcessStream, write, false);
      return fds;
    };
  }

  private restarting<T>(syscall: () => T): T {
    for (;;) {
      try {
        return syscall();
      } catch (e) {
        if (!(e instanceof SyscallError && e.code === 'EINTR' && this.options.restartable?.())) {
          throw e;
        }
      }
    }
  }

  private call<T>(syscall: () => T): T {
    try {
      return syscall();
    } catch (e) {
      if (e instanceof SyscallError) throw new this.Fs.ErrnoError(wasiErrno(e.code));
      throw e;
    }
  }

  private ops(kfd: number, base: StreamOps): StreamOps {
    return {
      ...base,

      llseek: () =>
        this.call(() => {
          throw new SyscallError('ESPIPE');
        }),
      read: (s, buffer, offset, length) =>
        this.call(() => {
          const bytes = this.restarting(() => this.sys.read(kfd, length, nonblocking(s)));
          buffer.set(bytes, offset);
          return bytes.length;
        }),
      write: (s, buffer, offset, length) => {
        try {
          const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length).slice();
          return this.restarting(() => this.sys.write(kfd, bytes, nonblocking(s)));
        } catch (e) {
          if (e instanceof SyscallError && e.code === 'EPIPE' && !this.options.sigpipe?.()) {
            throw new ProcessExit(KILLED_BY_SIGPIPE);
          }
          return this.call(() => {
            throw e;
          });
        }
      },
      fsync: () => 0,
      poll: () => {
        const state = this.call(() => this.sys.poll(kfd));
        let mask = 0;
        if (state.readable) mask |= POLLIN | POLLRDNORM;
        if (state.writable) mask |= POLLOUT | POLLWRNORM;

        if (state.hangup) mask |= state.readable ? POLLHUP : POLLERR;
        return mask;
      },
      dup: (stream) => {
        base.dup?.(stream);
        this.refs.set(kfd, (this.refs.get(kfd) ?? 0) + 1);
      },
      close: (stream) => {
        if (this.atExit && stream.fd === 2 && this.reporting.size > 0) this.commitStdout();
        try {
          base.close?.(stream);
        } catch {}
        const left = (this.refs.get(kfd) ?? 1) - 1;
        if (left > 0) {
          this.refs.set(kfd, left);
          return;
        }
        this.refs.delete(kfd);
        if (this.committed.size > 0 && this.committed.delete(kfd)) return;
        if (this.reporting.size > 0 && this.reporting.delete(kfd)) {
          this.reportedClose(stream, kfd);
          return;
        }
        try {
          this.sys.close(kfd);
        } catch {}
      },
    };
  }
}
