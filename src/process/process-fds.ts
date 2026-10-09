import { hostnameOf, hostsFile } from '../kernel/net/loopback-names.ts';
import type { MountLine } from '../kernel/proc-info.ts';
import type { ProcessFs, ProcessStream, ProcessSys } from './kernel-streams.ts';
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
    fcntl: (f) => cloexecFcntl(f, deps),
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

export function noFollowUtimes(
  imports: WebAssembly.Imports,
  fs: () => ProcessFs | undefined,
  glue?: unknown
): void {
  for (const namespace of namespaces(imports)) {
    const key = Object.keys(namespace).find(
      (name) => (glue !== undefined && namespace[name] === glue) || name === '__syscall_utimensat'
    );
    const utimensat = key === undefined ? undefined : namespace[key];
    if (key === undefined || typeof utimensat !== 'function') continue;
    namespace[key] = (dirfd: number, path: number, times: number, flags: number) => {
      const Fs = fs() as UtimeFs | undefined;
      const { utime, lookupPath, ErrnoError } = Fs ?? {};
      if (!Fs || !(flags & AT_SYMLINK_NOFOLLOW) || !utime || !lookupPath || !ErrnoError) {
        return utimensat(dirfd, path, times, flags);
      }
      Fs.utime = (at, atime, mtime) => {
        const { node } = lookupPath.call(Fs, at, { follow: false });
        if (!node.node_ops.setattr) throw new ErrnoError(EMSCRIPTEN_EPERM);
        node.node_ops.setattr(node, { atime, mtime });
      };
      try {
        return utimensat(dirfd, path, times, flags);
      } finally {
        Fs.utime = utime;
      }
    };
  }
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

export function fdOfPath(path: string, cwd: string): number | undefined {
  const parts: string[] = [];
  for (const part of `${path.startsWith('/') ? '' : cwd}/${path}`.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const abs = `/${parts.join('/')}`;
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

const field = (text: string) =>
  (text || 'none').replace(/[\s\\]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`);

export function mountTable(mounts: MountLine[] = []): string {
  const root = globalThis.navigator?.storage ? 'opfs' : 'memory';
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
  try {
    if (!live) writeFile.call(Fs, '/proc/mounts', mountTable());
  } catch {
    return;
  }
  try {
    mkdirTree.call(Fs, '/dev/.etc');
    writeFile.call(Fs, '/dev/.etc/passwd', passwd);
    writeFile.call(Fs, '/dev/.etc/group', group);
    writeFile.call(Fs, '/dev/.etc/hosts', hostsFile(hostnameOf(env)));
    writeFile.call(Fs, '/dev/.etc/hostname', `${hostnameOf(env)}\n`);
    backing['/etc/passwd'] = '/dev/.etc/passwd';
    backing['/etc/group'] = '/dev/.etc/group';
    backing['/etc/hosts'] = '/dev/.etc/hosts';
    backing['/etc/hostname'] = '/dev/.etc/hostname';
  } catch {}
  const open = Fs.open.bind(Fs);
  Fs.open = (path, flags, mode) => {
    const instead = backing[path];
    if (!instead || (flags & (O_ACCMODE | O_CREAT)) !== 0) return open(path, flags, mode);
    try {
      return open(path, flags, mode);
    } catch (e) {
      if ((e as { errno?: unknown })?.errno !== wasiErrno('ENOENT')) throw e;
      return open(instead, flags, mode);
    }
  };
}
