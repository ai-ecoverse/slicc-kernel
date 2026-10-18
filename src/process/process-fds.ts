import { devCreation, devRemoval } from '../fs/dev-removal.ts';
import { hostnameOf, hostsFile } from '../kernel/net/loopback-names.ts';
import type { MountLine } from '../kernel/proc-info.ts';
import { type LiveFsNode, type LiveLinkFs, linkLive, liveNodePath } from '../realm/live-vfs-fs.ts';
import { OS_RELEASE } from '../version.ts';
import type { ProcessFs, ProcessStream, ProcessSys } from './kernel-streams.ts';
import { type LockDeps, recordLock } from './process-locks.ts';
import { type PtyKernel, ptyIoctl } from './process-pty.ts';
import { wasiErrno } from './wasi-errno.ts';

export const O_CLOEXEC = 0o2000000;

const FD_CLOEXEC = 1;
const F_DUPFD = 0;
const F_GETFD = 1;
const F_SETFD = 2;
const F_GETFL = 3;
const F_DUPFD_CLOEXEC = 1030;

type CloexecStream = Pick<ProcessStream, 'sliccCloexec'>;

export function closesOnExec(stream: CloexecStream): boolean {
  return stream.sliccCloexec === true;
}

export function setCloseOnExec(stream: CloexecStream, on: boolean): void {
  if (on) stream.sliccCloexec = true;
  else delete stream.sliccCloexec;
}

const tracked = new WeakSet<ProcessFs>();

export function trackCloseOnExec(Fs: ProcessFs): void {
  if (tracked.has(Fs)) return;
  tracked.add(Fs);
  if (typeof Fs.dupStream === 'function') {
    const dupStream = Fs.dupStream.bind(Fs);
    Fs.dupStream = (stream, fd) => {
      const copy = dupStream(stream, fd);
      setCloseOnExec(copy, false);
      return copy;
    };
  }
  if (typeof Fs.open === 'function') {
    const open = Fs.open.bind(Fs);
    Fs.open = (path, flags, mode) => {
      const cloexec = typeof flags === 'number' && (flags & O_CLOEXEC) !== 0;
      const stream = open(path, cloexec ? flags & ~O_CLOEXEC : flags, mode);
      setCloseOnExec(stream, cloexec);
      return stream;
    };
  }
}

export type GlueSyscall = (...args: number[]) => number;

export interface GlueSyscalls {
  fcntl?: GlueSyscall;
  pipe2?: GlueSyscall;
  dup3?: GlueSyscall;
  socket?: GlueSyscall;
  accept4?: GlueSyscall;

  ioctl?: GlueSyscall;

  setitimer?: GlueSyscall;
}

export interface CloexecDeps {
  fs(): ProcessFs | undefined;

  heap(): Int32Array | undefined;

  pty?: PtyKernel;

  timer?: { arm(ms: number): void };

  locks?: Omit<LockDeps, 'fs'>;
}

function marker(deps: CloexecDeps): (fd: number, on: boolean) => void {
  return (fd, on) => {
    const stream = deps.fs()?.getStream(fd);
    if (stream) setCloseOnExec(stream, on);
  };
}

function cloexecFcntl(fcntl: GlueSyscall, deps: CloexecDeps): GlueSyscall {
  const mark = marker(deps);
  return (fd, cmd, varargs) => {
    if (cmd === F_DUPFD_CLOEXEC) {
      const copy = fcntl(fd, F_DUPFD, varargs);
      if (copy >= 0) mark(copy, true);
      return copy;
    }
    if (cmd === F_GETFL) {
      const flags = fcntl(fd, cmd, varargs);
      return flags < 0 ? flags : flags & ~O_CLOEXEC;
    }
    if (cmd !== F_GETFD && cmd !== F_SETFD) return fcntl(fd, cmd, varargs);
    const stream = deps.fs()?.getStream(fd);
    if (!stream) return -wasiErrno('EBADF');
    if (cmd === F_GETFD) return closesOnExec(stream) ? FD_CLOEXEC : 0;
    const arg = deps.heap()?.[varargs >> 2];
    if (arg === undefined) return -wasiErrno('EINVAL');
    setCloseOnExec(stream, (arg & FD_CLOEXEC) !== 0);
    return 0;
  };
}

function cloexecPipe2(pipe2: GlueSyscall, deps: CloexecDeps): GlueSyscall {
  const mark = marker(deps);
  return (fdPtr, flags) => {
    const r = pipe2(fdPtr, flags & ~O_CLOEXEC);
    const heap = deps.heap();
    if (r === 0 && flags & O_CLOEXEC && heap) {
      mark(heap[fdPtr >> 2] as number, true);
      mark(heap[(fdPtr >> 2) + 1] as number, true);
    }
    return r;
  };
}

function quietTarget(dup3: GlueSyscall, deps: CloexecDeps): GlueSyscall {
  return (fd = -1, newfd = -1, flags = 0, ...rest) => {
    const Fs = deps.fs();
    const target = fd === newfd || flags !== 0 ? undefined : Fs?.getStream(newfd);
    if (target && Fs?.getStream(fd)) {
      try {
        Fs.close?.(target);
      } catch {}
    }
    return dup3(fd, newfd, flags, ...rest);
  };
}

function cloexecByFlag(syscall: GlueSyscall, flagArg: number, deps: CloexecDeps): GlueSyscall {
  const mark = marker(deps);
  return (...args) => {
    const cloexec = ((args[flagArg] ?? 0) & O_CLOEXEC) !== 0;
    if (cloexec) args[flagArg] = (args[flagArg] as number) & ~O_CLOEXEC;
    const fd = syscall(...args);
    if (fd >= 0) mark(fd, cloexec);
    return fd;
  };
}

type SyscallName = keyof GlueSyscalls;

const IMPORT_NAMES: Readonly<Record<SyscallName, string>> = {
  fcntl: '__syscall_fcntl64',
  pipe2: '__syscall_pipe2',
  dup3: '__syscall_dup3',
  socket: '__syscall_socket',
  accept4: '__syscall_accept4',
  ioctl: '__syscall_ioctl',
  setitimer: '_setitimer_js',
};

function wrapperFactories(
  deps: CloexecDeps
): Partial<Record<SyscallName, (syscall: GlueSyscall) => GlueSyscall>> {
  const { pty, timer } = deps;
  return {
    ...(timer ? { setitimer: (f: GlueSyscall) => kernelTimer(f, timer) } : {}),
    fcntl: (f) =>
      cloexecFcntl(deps.locks ? recordLock(f, { ...deps.locks, fs: deps.fs }) : f, deps),
    pipe2: (f) => cloexecPipe2(f, deps),

    dup3: (f) => cloexecByFlag(quietTarget(f, deps), 2, deps),
    socket: (f) => cloexecByFlag(f, 1, deps),
    accept4: (f) => cloexecByFlag(f, 3, deps),
    ...(pty
      ? { ioctl: (f: GlueSyscall) => ptyIoctl(f, { fs: deps.fs, heap: deps.heap, kernel: pty }) }
      : {}),
  };
}

function kernelTimer(setitimer: GlueSyscall, timer: { arm(ms: number): void }): GlueSyscall {
  return (which, ms) => {
    if (which !== 0) return setitimer(which, ms);
    timer.arm(ms ?? 0);
    return 0;
  };
}

function syscallOf(glue: GlueSyscalls, name: string, value: unknown): SyscallName | undefined {
  const names = Object.keys(IMPORT_NAMES) as SyscallName[];
  const own = names.find((key) => glue[key] !== undefined && glue[key] === value);
  if (own) return own;

  return typeof value === 'function'
    ? names.find((key) => glue[key] !== undefined && IMPORT_NAMES[key] === name)
    : undefined;
}

export function wrapCloexecSyscalls(
  imports: WebAssembly.Imports,
  glue: GlueSyscalls | undefined,
  deps: CloexecDeps
): void {
  if (!glue) return;
  const factories = wrapperFactories(deps);
  const seen = new Set<object>();
  for (const namespace of Object.values(imports)) {
    if (!namespace || typeof namespace !== 'object' || seen.has(namespace)) continue;
    seen.add(namespace);
    for (const [name, value] of Object.entries(namespace)) {
      const key = syscallOf(glue, name, value);
      const wrap = key && factories[key];
      if (wrap) namespace[name] = wrap(value as GlueSyscall);
    }
  }
}

const EBADF = 8;
const AT_SYMLINK_NOFOLLOW = 0x100;
const EMSCRIPTEN_EPERM = 63;

interface UtimeNode {
  node_ops: {
    setattr?(node: UtimeNode, attr: { atime: number | null; mtime: number | null }): void;
  };
}

interface UtimeFs {
  utime?(path: string, atime: number | null, mtime: number | null): void;
  lookupPath?(path: string, opts: { follow: boolean }): { node: UtimeNode };
  ErrnoError?: new (errno: number) => Error;
}

const O_PATH = 0o10000000;

interface MayOpenFs {
  mayOpen?(node: { mode: number }, flags: number): number;
  isLink?(mode: number): boolean;
}

export function pathOpensLinks(Fs: ProcessFs): void {
  const fs = Fs as unknown as MayOpenFs;
  const { mayOpen, isLink } = fs;
  if (!mayOpen || !isLink) return;
  fs.mayOpen = (node, flags) =>
    flags & O_PATH && isLink.call(fs, node.mode) ? 0 : mayOpen.call(fs, node, flags);
}

type Syscall = (...args: number[]) => number;

export interface KernelImports {
  openat?: unknown;
  mkdirat?: unknown;
  mknodat?: unknown;
  umask?: unknown;
  faccessat?: unknown;
  linkat?: unknown;
  symlinkat?: unknown;
  uname?: unknown;
  utimensat?: unknown;
  getppid?: unknown;
  resizeHeap?: unknown;
  fdWrite?: unknown;
  fdRead?: unknown;
  sleepMs?: unknown;
  flock?: unknown;
}

const LITERALS: Record<keyof KernelImports, string> = {
  openat: '__syscall_openat',
  mkdirat: '__syscall_mkdirat',
  mknodat: '__syscall_mknodat',
  umask: '__syscall_umask',
  faccessat: '__syscall_faccessat',
  linkat: '__syscall_linkat',
  symlinkat: '__syscall_symlinkat',
  uname: '__syscall_uname',
  utimensat: '__syscall_utimensat',
  getppid: 'slicc_getppid_js',
  resizeHeap: 'emscripten_resize_heap',
  fdWrite: 'fd_write',
  fdRead: 'fd_read',
  sleepMs: 'slicc_sleep_ms',
  flock: '__syscall_flock',
};

export function importKey(
  namespace: WebAssembly.ModuleImports,
  name: keyof KernelImports,
  glue: KernelImports | undefined
): string | undefined {
  const own = glue?.[name];
  if (typeof own === 'function') {
    const found = Object.keys(namespace).find((k) => namespace[k] === own);
    if (found !== undefined) return found;
  }
  const literal = LITERALS[name];
  return typeof namespace[literal] === 'function' ? literal : undefined;
}

export function wrapImport(
  imports: WebAssembly.Imports,
  name: keyof KernelImports,
  glue: KernelImports | undefined,
  wrap: (original: Syscall) => Syscall,
  optional = false
): void {
  let wrapped = false;
  for (const ns of namespaces(imports)) {
    const key = importKey(ns, name, glue);
    if (key === undefined) continue;
    ns[key] = wrap(ns[key] as Syscall);
    wrapped = true;
  }
  if (!wrapped && !optional && typeof glue?.[name] === 'function') {
    throw new Error(`slicc-kernel cannot find the glue's ${LITERALS[name]} among its imports`);
  }
}

export interface UmaskDeps {
  initial: number;
  memory(): WebAssembly.Memory | undefined;
  set(mask: number): void;
  glue?: KernelImports | undefined;
}

export function kernelUmask(imports: WebAssembly.Imports, deps: UmaskDeps): void {
  let umask = deps.initial & 0o777;
  const { glue } = deps;
  wrapImport(imports, 'openat', glue, (openat) => (dirfd, path, flags, varargs) => {
    const memory = deps.memory();
    if (flags & O_CREAT && varargs && memory) new Int32Array(memory.buffer)[varargs >> 2] &= ~umask;
    return openat(dirfd, path, flags, varargs);
  });
  wrapImport(
    imports,
    'mkdirat',
    glue,
    (mkdirat) => (dirfd, path, mode) => mkdirat(dirfd, path, mode & ~umask)
  );
  wrapImport(
    imports,
    'mknodat',
    glue,
    (mknodat) => (dirfd, path, mode, dev) => mknodat(dirfd, path, mode & ~umask, dev)
  );
  wrapImport(imports, 'umask', glue, (own) => {
    own(umask);
    return (mask) => {
      const old = umask;
      umask = mask & 0o777;
      own(umask);
      deps.set(umask);
      return old;
    };
  });
}

const UTIME_NOW = 0x3fffffff;
const UTIME_OMIT = 0x3ffffffe;

function touching(times: number, memory: WebAssembly.Memory | undefined): boolean {
  if (times === 0) return true;
  if (!memory) return false;
  const heap = new Int32Array(memory.buffer);
  const nsec = [heap[(times + 8) >> 2], heap[(times + 24) >> 2]];
  return nsec.every((n) => n === UTIME_NOW || n === UTIME_OMIT);
}

function touch<T>(Fs: TouchFs | undefined, on: boolean, run: () => T): T {
  if (!Fs || !on) return run();
  Fs.sliccTouch = true;
  try {
    return run();
  } finally {
    Fs.sliccTouch = undefined;
  }
}

interface TouchFs {
  sliccTouch?: boolean;
}

export function noFollowUtimes(
  imports: WebAssembly.Imports,
  fs: () => ProcessFs | undefined,
  glue?: unknown,
  memory: () => WebAssembly.Memory | undefined = () => undefined
): void {
  wrapImport(
    imports,
    'utimensat',
    { utimensat: glue },
    (utimensat) => (dirfd, path, times, flags) => {
      const Fs = fs() as (UtimeFs & TouchFs) | undefined;
      const on = touching(times, memory());
      const { utime, lookupPath, ErrnoError } = Fs ?? {};
      if (!Fs || !(flags & AT_SYMLINK_NOFOLLOW) || !utime || !lookupPath || !ErrnoError) {
        return touch(Fs, on, () => utimensat(dirfd, path, times, flags));
      }
      Fs.utime = (at, atime, mtime) => {
        const { node } = lookupPath.call(Fs, at, { follow: false });
        if (!node.node_ops.setattr) throw new ErrnoError(EMSCRIPTEN_EPERM);
        node.node_ops.setattr(node, { atime, mtime });
      };
      try {
        return touch(Fs, on, () => utimensat(dirfd, path, times, flags));
      } finally {
        Fs.utime = utime;
      }
    }
  );
}

type AsyncImport = ((...args: number[]) => unknown) & { isAsync?: boolean };

function errnoOf(err: unknown): number {
  const { errno, code } = (err ?? {}) as { errno?: unknown; code?: unknown };
  if (typeof errno === 'number') return errno;
  if (typeof code === 'string') return wasiErrno(code);
  throw err;
}

function persistsItself(stream: ProcessStream): boolean {
  const type = stream.node.mount?.type as { syncfs?: unknown } | undefined;
  return typeof type?.syncfs === 'function';
}

export interface FdImports {
  fd_sync?: unknown;
  fd_pread?: unknown;
  fd_pwrite?: unknown;
}

function namespaces(imports: WebAssembly.Imports): WebAssembly.ModuleImports[] {
  const seen = new Set<WebAssembly.ModuleImports>();
  for (const namespace of Object.values(imports)) {
    if (namespace && typeof namespace === 'object') seen.add(namespace);
  }
  return [...seen];
}

function keyOf(
  namespace: WebAssembly.ModuleImports,
  name: keyof FdImports,
  glue: FdImports | undefined
): string | undefined {
  const own = glue?.[name];
  const found =
    typeof own === 'function'
      ? Object.keys(namespace).find((k) => namespace[k] === own)
      : undefined;
  return found ?? (typeof namespace[name] === 'function' ? name : undefined);
}

export function syncFsync(
  imports: WebAssembly.Imports,
  fs: () => ProcessFs | undefined,
  glue?: FdImports
): void {
  for (const namespace of namespaces(imports)) {
    const key = keyOf(namespace, 'fd_sync', glue);
    const original = key === undefined ? undefined : (namespace[key] as AsyncImport);
    if (key === undefined || !original?.isAsync) continue;
    namespace[key] = (fd: number) => {
      const stream = fs()?.getStream(fd);
      if (!stream) return EBADF;
      if (persistsItself(stream)) return original(fd);
      try {
        const result = stream.stream_ops.fsync?.(stream);
        return typeof result === 'number' ? result : 0;
      } catch (err) {
        return errnoOf(err);
      }
    };
  }
}

type Positional = (...args: (number | bigint)[]) => number;

interface PositionalDeps {
  glue?: FdImports | undefined;
  fs: () => ProcessFs | undefined;
  sys: Pick<ProcessSys, 'pread' | 'pwrite'>;
  memory: () => WebAssembly.Memory | undefined;
}

function offsetOf(rest: (number | bigint)[]): number | undefined {
  const at =
    rest.length >= 3
      ? Number(rest[1]) * 2 ** 32 + (Number(rest[0]) >>> 0)
      : Number(BigInt.asIntN(64, BigInt(rest[0])));
  return at >= 0 && Number.isSafeInteger(at) ? at : undefined;
}

function readInto(sys: PositionalDeps['sys'], kfd: number, target: Uint8Array, at: number): number {
  let done = 0;
  while (done < target.length) {
    const got = sys.pread?.(kfd, target.length - done, at + done) ?? new Uint8Array(0);
    if (got.length === 0) break;
    target.set(got, done);
    done += got.length;
  }
  return done;
}

function positioned(original: Positional, write: boolean, deps: PositionalDeps): Positional {
  return (fd, iov, iovcnt, ...rest) => {
    const stream = deps.fs()?.getStream(Number(fd));
    const memory = deps.memory();
    const kfd = stream?.sliccKernelFile ? stream.sliccKernelFd : undefined;
    if (kfd === undefined || !memory || !(write ? deps.sys.pwrite : deps.sys.pread)) {
      return original(fd, iov, iovcnt, ...rest);
    }
    const at = offsetOf(rest);
    if (at === undefined) return wasiErrno('EINVAL');
    const view = new DataView(memory.buffer);
    let done = 0;
    try {
      for (let i = 0; i < Number(iovcnt); i++) {
        const ptr = view.getUint32(Number(iov) + i * 8, true);
        const len = view.getUint32(Number(iov) + i * 8 + 4, true);
        const part = new Uint8Array(memory.buffer, ptr, len);
        const moved = write
          ? (deps.sys.pwrite?.(kfd, part.slice(), at + done) ?? 0)
          : readInto(deps.sys, kfd, part, at + done);
        done += moved;
        if (moved < len) break;
      }
    } catch (err) {
      return errnoOf(err);
    }
    view.setUint32(Number(rest[rest.length - 1]), done, true);
    return 0;
  };
}

export function positionalIo(imports: WebAssembly.Imports, deps: PositionalDeps): void {
  for (const namespace of namespaces(imports)) {
    for (const [name, write] of [
      ['fd_pread', false],
      ['fd_pwrite', true],
    ] as const) {
      const key = keyOf(namespace, name, deps.glue);
      if (key !== undefined) {
        namespace[key] = positioned(namespace[key] as Positional, write, deps);
      }
    }
  }
}

const PROT_WRITE = 2;
const MAP_PRIVATE = 2;
const MAP_TYPE = 0xf;
const O_WRONLY = 1;
const MAP_ALIGN = 65536;

type Mmap = (
  stream: ProcessStream,
  length: number,
  position: number,
  prot: number,
  flags: number
) => { ptr: number; allocated: boolean };

export type Memalign = (alignment: number, size: number) => number;

export interface MmapDeps {
  sys: Pick<ProcessSys, 'pread'>;
  memory: () => WebAssembly.Memory | undefined;
  memalign: () => Memalign | undefined;
}

function staging(Fs: ProcessFs, length: number): Uint8Array {
  try {
    return new Uint8Array(length);
  } catch {
    throw new Fs.ErrnoError(wasiErrno('ENOMEM'));
  }
}

export function useFileMmap(Fs: ProcessFs, deps: MmapDeps): void {
  const fs = Fs as ProcessFs & { mmap?: Mmap };
  const mmap = fs.mmap;
  if (typeof mmap !== 'function') return;
  fs.mmap = (stream, length, position, prot, flags) => {
    const memalign = deps.memalign();
    const memory = deps.memory();
    const shared = (flags & MAP_TYPE) !== MAP_PRIVATE && (prot & PROT_WRITE) !== 0;
    const kfd = stream.sliccKernelFile ? stream.sliccKernelFd : undefined;
    if (shared && kfd !== undefined) throw new Fs.ErrnoError(wasiErrno('ENODEV'));
    if (
      (stream.stream_ops.mmap && kfd === undefined) ||
      !memalign ||
      !memory ||
      length <= 0 ||
      shared ||
      (stream.flags & O_ACCMODE) === O_WRONLY ||
      !Fs.isFile(stream.node.mode)
    ) {
      return mmap.call(fs, stream, length, position, prot, flags);
    }
    const data = staging(Fs, length);
    let done = 0;
    try {
      if (kfd !== undefined) done = readInto(deps.sys, kfd, data, position);
      else {
        for (let got = 1; done < length && got > 0; done += got) {
          got = Fs.read(stream, data, done, length - done, position + done);
        }
      }
    } catch (err) {
      throw new Fs.ErrnoError(errnoOf(err));
    }
    const size = Math.ceil(length / MAP_ALIGN) * MAP_ALIGN;
    const ptr = memalign(MAP_ALIGN, size);
    if (!ptr) throw new Fs.ErrnoError(wasiErrno('ENOMEM'));
    const target = new Uint8Array(memory.buffer, ptr, size);
    target.fill(0);
    target.set(data.subarray(0, done));
    return { ptr, allocated: true };
  };
}

export function wasmMemory(
  instance: WebAssembly.Instance,
  imports: WebAssembly.Imports
): WebAssembly.Memory | undefined {
  const isMemory = (v: unknown): v is WebAssembly.Memory => v instanceof WebAssembly.Memory;
  const exported = Object.values(instance.exports).find(isMemory);
  if (exported) return exported;
  for (const namespace of Object.values(imports)) {
    const found = Object.values(namespace ?? {}).find(isMemory);
    if (found) return found;
  }
  return undefined;
}

function absoluteOf(path: string, cwd: string): string {
  const parts: string[] = [];
  for (const part of `${path.startsWith('/') ? '' : cwd}/${path}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function fdOfPath(path: string, cwd: string): number | undefined {
  const abs = absoluteOf(path, cwd);
  const std = ['/dev/stdin', '/dev/stdout', '/dev/stderr'].indexOf(abs);
  if (std >= 0) return std;
  const m = /^\/(?:dev|proc\/self)\/fd\/(\d+)$/.exec(abs);
  return m ? Number(m[1]) : undefined;
}

const DIR_MODE = 0o040555;
const LINK_MODE = 0o120700;

function syntheticAttr(mode: number, ino: number): object {
  const now = new Date();
  return {
    dev: 1,
    ino,
    mode,
    nlink: 1,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: 0,
    atime: now,
    mtime: now,
    ctime: now,
    blksize: 4096,
    blocks: 0,
  };
}

interface FdDirNode {
  id?: number;
  node_ops?: {
    lookup?: (parent: FdDirNode, name: string) => FdDirNode;
    getattr?: (node: FdDirNode) => object;
  };
}

function describeFdDir(Fs: ProcessFs): void {
  let dir: FdDirNode | undefined;
  try {
    dir = Fs.lookupPath?.('/proc/self/fd', { follow: true })?.node as FdDirNode | undefined;
  } catch {
    return;
  }
  const ops = dir?.node_ops;
  const lookup = ops?.lookup;
  if (!dir || !lookup || ops.getattr) return;
  dir.node_ops = {
    ...ops,
    getattr: () => syntheticAttr(DIR_MODE, 1),
    lookup: (parent, name) => {
      const entry = lookup(parent, name);
      entry.node_ops = {
        ...entry.node_ops,
        getattr: () => syntheticAttr(LINK_MODE, entry.id ?? 0),
      };
      return entry;
    },
  };
}

interface DeviceFs {
  analyzePath?: (path: string) => { exists: boolean };
  registerDevice?: (dev: number, ops: object) => void;
  mkdev?: (path: string, mode: number, dev: number) => unknown;
  makedev?: (major: number, minor: number) => number;
}

const CHAR_DEVICE = 0o20666;

export function useZeroDevices(Fs: ProcessFs): void {
  const { analyzePath, registerDevice, mkdev, makedev } = Fs as unknown as DeviceFs;
  if (!analyzePath || !registerDevice || !mkdev || !makedev) return;
  const zeros = (_s: unknown, buffer: Uint8Array, offset: number, length: number) => {
    buffer.fill(0, offset, offset + length);
    return length;
  };
  const devices = [
    ['/dev/zero', 5, (_s: unknown, _b: Uint8Array, _o: number, length: number) => length],
    [
      '/dev/full',
      7,
      (_s: unknown, _b: Uint8Array, _o: number, length: number) => {
        if (length > 0) throw new Fs.ErrnoError(wasiErrno('ENOSPC'));
        return 0;
      },
    ],
  ] as const;
  for (const [path, minor, write] of devices) {
    if (analyzePath.call(Fs, path).exists) continue;
    const dev = makedev.call(Fs, 1, minor);
    registerDevice.call(Fs, dev, { read: zeros, write, llseek: () => 0 });
    mkdev.call(Fs, path, CHAR_DEVICE, dev);
  }
}

interface RemovalFs {
  unlink?(path: string): void;
  rmdir?(path: string): void;
  sliccCred?: { euid: number };
}

interface FifoOpenFs {
  sliccOpenFifo?: (stream: ProcessStream, path: string) => void;
  open?: (path: unknown, flags: unknown, ...rest: unknown[]) => unknown;
  lookupPath?: (path: string, opts?: { follow?: boolean }) => { node: { mode: number } };
}

const O_TRUNC = 0o1000;
const S_IFMT_BITS = 0o170000;
const S_IFIFO_BITS = 0o010000;

function namesFifo(fs: FifoOpenFs, path: string, flags: number): boolean {
  try {
    const { node } = fs.lookupPath?.(path, { follow: true }) ?? { node: { mode: 0 } };
    return (node.mode & S_IFMT_BITS) === S_IFIFO_BITS;
  } catch (err) {
    const { errno, code } = (err ?? {}) as { errno?: unknown; code?: unknown };
    const errnum = typeof errno === 'number' ? errno : wasiErrno(String(code));
    if (REFUSED.has(errnum) && (flags & OWN_ERRORS) === 0) throw err;
    return false;
  }
}

const REFUSED: ReadonlySet<number> = new Set([wasiErrno('EACCES'), wasiErrno('EPERM')]);
const OWN_ERRORS = 0o200 | 0o400000;

export function useFifoOpens(
  Fs: ProcessFs,
  attach?: (stream: ProcessStream, path: string) => void
): void {
  const fs = Fs as unknown as FifoOpenFs;
  if (attach) fs.sliccOpenFifo = attach;
  const open = fs.open;
  if (typeof open !== 'function' || typeof fs.lookupPath !== 'function') return;
  fs.open = (path, flags, ...rest) => {
    const truncates = typeof path === 'string' && typeof flags === 'number' && flags & O_TRUNC;
    const kept =
      truncates && namesFifo(fs, path as string, flags as number)
        ? (flags as number) & ~O_TRUNC
        : flags;
    return open.call(Fs, path, kept, ...rest);
  };
}

export function useDevRemoval(Fs: ProcessFs): void {
  const fs = Fs as unknown as RemovalFs;
  for (const name of ['unlink', 'rmdir'] as const) {
    const remove = fs[name];
    if (typeof remove !== 'function') continue;
    fs[name] = (path: string) => {
      const refused = devRemoval(absoluteOf(path, Fs.cwd()), fs.sliccCred);
      if (refused) throw new Fs.ErrnoError(wasiErrno(refused));
      remove.call(Fs, path);
    };
  }
}

function linkStdio(Fs: ProcessFs): void {
  const { unlink, symlink } = Fs as { unlink?: (path: string) => void } & ProcessFs;
  if (!unlink || !symlink) return;
  for (const [fd, name] of ['stdin', 'stdout', 'stderr'].entries()) {
    try {
      unlink.call(Fs, `/dev/${name}`);
    } catch {}
    try {
      symlink.call(Fs, `/proc/self/fd/${fd}`, `/dev/${name}`);
    } catch {}
  }
}

export function useDevFd(Fs: ProcessFs): void {
  if (typeof Fs.open !== 'function') return;
  try {
    Fs.symlink?.('/proc/self/fd', '/dev/fd');
  } catch {}
  linkStdio(Fs);
  describeFdDir(Fs);
  const fdOf = (path: unknown): number | undefined =>
    typeof path === 'string' ? fdOfPath(path, Fs.cwd()) : undefined;
  const target = (fd: number): ProcessStream => {
    const stream = Fs.getStream(fd);
    if (!stream) throw new Fs.ErrnoError(wasiErrno('EBADF'));
    return stream;
  };
  const open = Fs.open.bind(Fs);
  Fs.open = (path, flags, mode) => {
    const fd = fdOf(path);
    if (fd === undefined) return open(path, flags, mode);
    const copy = Fs.dupStream(target(fd), -1);
    setCloseOnExec(copy, typeof flags === 'number' && (flags & O_CLOEXEC) !== 0);
    return copy;
  };
  const { stat, fstat } = Fs;
  if (typeof stat !== 'function' || typeof fstat !== 'function') return;
  Fs.stat = (path, dontFollow) => {
    const fd = dontFollow ? undefined : fdOf(path);
    if (fd === undefined) return stat.call(Fs, path, dontFollow);
    target(fd);
    return fstat.call(Fs, fd);
  };
}

const O_ACCMODE = 0o3;
const O_CREAT = 0o100;
const O_EXCL = 0o200;

const field = (text: string) =>
  (text || 'none').replace(/[\s\\]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`);

let pinnedRoot: string | undefined;

const rootKind = (): string => (globalThis.navigator?.storage ? 'opfs' : 'memory');

export function pinRootKind(): void {
  pinnedRoot = rootKind();
}

export function mountTable(mounts: MountLine[] = []): string {
  const root = pinnedRoot ?? rootKind();
  const lines = [`${root} / ${root} rw 0 0`, 'devfs /dev devfs rw 0 0', 'proc /proc proc rw 0 0'];
  for (const m of mounts) {
    const options = Object.entries(m.options).map(([k, v]) => (v === '' ? k : `${k}=${v}`));
    if (m.state !== 'ok') options.push(m.state);
    const access = options.includes('ro') ? [] : ['rw'];
    lines.push(
      `${field(m.source)} ${field(m.target)} ${m.type} ${[...access, ...options].join(',')} 0 0`
    );
  }
  return `${lines.join('\n')}\n`;
}

const NAME = /^[a-z_][a-z0-9_-]*$/i;

export function accounts(env: Record<string, string> = {}): { passwd: string; group: string } {
  const user = env.USER ?? 'web_user';
  const name = NAME.test(user) && user !== 'root' ? user : 'user';
  const home = env.HOME || '/home';
  return {
    passwd: `root:x:0:0:root:/root:/bin/sh\n${name}:x:1000:1000:${name}:${home}:/bin/bash\n`,
    group: `root:x:0:\n${name}:x:1000:\n`,
  };
}

export function useMounts(Fs: ProcessFs, env: Record<string, string> = {}, live = false): void {
  const { writeFile, mkdirTree } = Fs;
  if (typeof Fs.open !== 'function' || typeof writeFile !== 'function') return;
  const { passwd, group } = accounts(env);
  const backing: Record<string, string> = { '/etc/mtab': '/proc/mounts' };
  const defaults: Record<string, string> = {};
  try {
    if (!live) writeFile.call(Fs, '/proc/mounts', mountTable());
  } catch {
    return;
  }
  try {
    mkdirTree.call(Fs, '/dev/.etc');
    const files = {
      passwd,
      group,
      hosts: hostsFile(hostnameOf(env)),
      hostname: `${hostnameOf(env)}\n`,
    };
    for (const [name, text] of Object.entries(files)) {
      writeFile.call(Fs, `/dev/.etc/${name}`, text);
      backing[`/etc/${name}`] = `/dev/.etc/${name}`;
      defaults[`/etc/${name}`] = text;
    }
  } catch {}
  const open = Fs.open.bind(Fs);
  const seed = (path: string, text: string): void => {
    let stream: ProcessStream;
    try {
      stream = open(path, O_WRONLY | O_CREAT | O_EXCL, 0o644);
    } catch {
      return;
    }
    try {
      const bytes = new TextEncoder().encode(text);
      Fs.write(stream, bytes, 0, bytes.length);
    } finally {
      Fs.closeStream(stream.fd);
    }
  };
  Fs.open = (path, flags, mode) => {
    const instead = backing[path];
    const text = defaults[path];
    if (text !== undefined && (flags & (O_ACCMODE | O_CREAT)) !== 0) seed(path, text);
    if (!instead || (flags & (O_ACCMODE | O_CREAT)) !== 0) return open(path, flags, mode);
    try {
      return open(path, flags, mode);
    } catch (e) {
      if ((e as { errno?: unknown })?.errno !== wasiErrno('ENOENT')) throw e;
      return open(instead, flags, mode);
    }
  };
}

const AT_FDCWD = -100;
const AT_EACCESS = 0x200;

interface AccessFs {
  lookupPath?(path: string, opts: { follow: boolean }): { node: LiveFsNode };
  cwd?(): string;
  getStream?(fd: number): { path?: string } | null | undefined;
}

function cString(memory: WebAssembly.Memory, at: number): string {
  const bytes = new Uint8Array(memory.buffer, at);
  return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
}

function baseOf(Fs: AccessFs, dirfd: number): string {
  return dirfd === AT_FDCWD ? (Fs.cwd?.() ?? '/') : (Fs.getStream?.(dirfd)?.path ?? '/');
}

const W_ACCESS = 2;
const X_ACCESS = 1;

function readonlyRefusal(
  Fs: AccessFs,
  memory: WebAssembly.Memory,
  call: { dirfd: number; path: number; amode: number; flags: number }
): number {
  if (!(call.amode & W_ACCESS)) return 0;
  try {
    const name = cString(memory, call.path);
    const abs = name.startsWith('/') ? name : `${baseOf(Fs, call.dirfd)}/${name}`;
    const follow = (call.flags & AT_SYMLINK_NOFOLLOW) === 0;
    const { node } = (Fs.lookupPath as NonNullable<AccessFs['lookupPath']>).call(Fs, abs, {
      follow,
    });
    const bridge = node.live ? node.mount.opts.bridge : undefined;
    type Stat = (path: string) => { readonly?: boolean };
    const stats = bridge as { stat?: Stat; lstat?: Stat } | undefined;
    const stat = follow ? stats?.stat : stats?.lstat;
    return stat?.call(stats, liveNodePath(node)).readonly ? -wasiErrno('EROFS') : 0;
  } catch {
    return 0;
  }
}

function kernelChecks(
  Fs: AccessFs,
  memory: WebAssembly.Memory,
  call: { dirfd: number; path: number; amode: number; flags: number }
): number {
  const name = cString(memory, call.path);
  const abs = name.startsWith('/') ? name : `${baseOf(Fs, call.dirfd)}/${name}`;
  const lookupPath = Fs.lookupPath as NonNullable<AccessFs['lookupPath']>;
  const { node } = lookupPath.call(Fs, abs, { follow: (call.flags & AT_SYMLINK_NOFOLLOW) === 0 });
  const bridge = node.live ? node.mount.opts.bridge : undefined;
  if (!bridge?.owners || !bridge.access) return 0;
  const kind = call.flags & AT_EACCESS ? 'eaccess' : 'access';
  bridge.access(liveNodePath(node), call.amode, kind, (call.flags & AT_SYMLINK_NOFOLLOW) !== 0);
  return 0;
}

export function kernelAccess(
  imports: WebAssembly.Imports,
  fs: () => ProcessFs | undefined,
  memory: () => WebAssembly.Memory | undefined,
  glue?: KernelImports
): void {
  wrapImport(imports, 'faccessat', glue, (own) => (dirfd, path, amode, flags) => {
    const Fs = fs() as AccessFs | undefined;
    const heap = memory();
    const call = { dirfd, path, amode: amode & 7, flags };
    const refused = Fs?.lookupPath && heap ? readonlyRefusal(Fs, heap, call) : 0;
    if (refused !== 0) return refused;
    const rc = own(dirfd, path, amode, flags);
    if (rc !== 0 || !Fs?.lookupPath || !heap) return rc;
    try {
      return kernelChecks(Fs, heap, { dirfd, path, amode: amode & 7, flags });
    } catch (err) {
      return -errnoOf(err);
    }
  });
}

const AT_SYMLINK_FOLLOW = 0x400;

export function kernelLink(
  imports: WebAssembly.Imports,
  fs: () => ProcessFs | undefined,
  memory: () => WebAssembly.Memory | undefined,
  glue?: KernelImports
): void {
  wrapImport(
    imports,
    'linkat',
    glue,
    (own) => (olddirfd, oldpath, newdirfd, newpath, flags) => {
      const Fs = fs() as (AccessFs & Partial<LiveLinkFs>) | undefined;
      const heap = memory();
      if (!Fs?.lookupPath || !heap) return own(olddirfd, oldpath, newdirfd, newpath, flags);
      const at = (dirfd: number, ptr: number) => {
        const name = cString(heap, ptr);
        return name.startsWith('/') ? name : `${baseOf(Fs, dirfd)}/${name}`;
      };
      try {
        const from = at(olddirfd, oldpath);
        const to = at(newdirfd, newpath);
        const follow = (flags & AT_SYMLINK_FOLLOW) !== 0;
        if (linkLive(Fs as LiveLinkFs, from, to, follow)) return 0;
      } catch (err) {
        return -errnoOf(err);
      }
      return own(olddirfd, oldpath, newdirfd, newpath, flags);
    },
    true
  );
}

interface CreationFs extends AccessFs {
  sliccCred?: { euid: number };
}

function refusedCreation(Fs: CreationFs, heap: WebAssembly.Memory, dirfd: number, ptr: number) {
  const name = cString(heap, ptr);
  const path = absoluteOf(name, name.startsWith('/') ? '/' : baseOf(Fs, dirfd));
  const refused = devCreation(path, Fs.sliccCred);
  if (!refused || !Fs.lookupPath) return 0;
  try {
    Fs.lookupPath(path, { follow: false });
    return 0;
  } catch {
    return -wasiErrno(refused);
  }
}

export function devCreations(
  imports: WebAssembly.Imports,
  fs: () => ProcessFs | undefined,
  memory: () => WebAssembly.Memory | undefined,
  glue?: KernelImports
): void {
  const check = (dirfd: number, ptr: number) => {
    const Fs = fs() as CreationFs | undefined;
    const heap = memory();
    return Fs && heap ? refusedCreation(Fs, heap, dirfd, ptr) : 0;
  };
  wrapImport(
    imports,
    'openat',
    glue,
    (own) => (dirfd, path, flags, varargs) =>
      (flags & O_CREAT && check(dirfd, path)) || own(dirfd, path, flags, varargs),
    true
  );
  wrapImport(
    imports,
    'mkdirat',
    glue,
    (own) => (dirfd, path, mode) => check(dirfd, path) || own(dirfd, path, mode),
    true
  );
  wrapImport(
    imports,
    'mknodat',
    glue,
    (own) => (dirfd, path, mode, dev) => check(dirfd, path) || own(dirfd, path, mode, dev),
    true
  );
  wrapImport(
    imports,
    'symlinkat',
    glue,
    (own) => (target, dirfd, path) => check(dirfd, path) || own(target, dirfd, path),
    true
  );
}

const UTS_FIELD = 65;

export function kernelUname(
  imports: WebAssembly.Imports,
  hostname: string,
  memory: () => WebAssembly.Memory | undefined,
  glue?: KernelImports
): void {
  const fields = ['Linux', hostname, OS_RELEASE, '#1 SMP PREEMPT_DYNAMIC', 'wasm32', '(none)'];
  const encoded = fields.map((f) => new TextEncoder().encode(f).subarray(0, UTS_FIELD - 1));
  wrapImport(
    imports,
    'uname',
    glue,
    (own) => (buf) => {
      const heap = memory();
      if (!buf || !heap) return own(buf);
      const bytes = new Uint8Array(heap.buffer, buf, UTS_FIELD * fields.length);
      bytes.fill(0);
      encoded.forEach((field, i) => {
        bytes.set(field, i * UTS_FIELD);
      });
      return 0;
    },
    true
  );
}

const DEVICE_MODES: ReadonlyArray<[string, number]> = [
  ['/', 0o755],
  ['/dev', 0o755],
  ['/dev/null', 0o666],
  ['/dev/zero', 0o666],
  ['/dev/full', 0o666],
  ['/dev/random', 0o666],
  ['/dev/urandom', 0o666],
  ['/dev/tty', 0o666],
  ['/dev/shm', 0o1777],
];

interface ChmodFs {
  chmod?(path: string, mode: number): void;
}

interface ChdirFs extends AccessFs {
  chdir?(path: string): void;
  sliccChdirAt?(path: string): void;
  isDir?(mode: number): boolean;
  ErrnoError?: new (errno: number) => Error;
}

function kernelChdir(Fs: ChdirFs): void {
  const { chdir, lookupPath, ErrnoError } = Fs;
  if (!chdir || !lookupPath || !ErrnoError) return;
  Fs.sliccChdirAt = chdir;
  Fs.chdir = (path: string) => {
    const { node } = lookupPath.call(Fs, path, { follow: true });
    const directory = Fs.isDir?.(node.mode) === true;
    const bridge = node.live && directory ? node.mount.opts.bridge : undefined;
    try {
      bridge?.access?.(liveNodePath(node), X_ACCESS, 'eaccess', false);
    } catch (err) {
      throw new ErrnoError(errnoOf(err));
    }
    chdir.call(Fs, path);
  };
}

export function linuxDevices(Fs: ProcessFs): void {
  (Fs as { ignorePermissions?: boolean }).ignorePermissions = true;
  kernelChdir(Fs as unknown as ChdirFs);
  const { chmod } = Fs as unknown as ChmodFs;
  if (!chmod) return;
  for (const [path, mode] of DEVICE_MODES) {
    try {
      chmod.call(Fs, path, mode);
    } catch {}
  }
}
