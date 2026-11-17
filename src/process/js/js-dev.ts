import { inShm } from '../../fs/dev-removal.ts';
import {
  BY_ID,
  DEVICE_NAME,
  type DeviceMetaChange,
  type DeviceNodeInfo,
} from '../../kernel/devices.ts';
import type { DeviceMeta } from '../../kernel/fd-table.ts';
import { CBAUD, codeOf, IOCTL, type SerialTermios, TIOCM } from '../../kernel/serial-ioctl.ts';
import { parseSyncFsStat, type SyncFsBridgeStat } from '../../realm/sync-fs-wire.ts';
import type { SyncSabRequestBody } from '../../realm/sync-sab-wire.ts';
import type { JsFile } from './js-context.ts';
import {
  type FdInfo,
  index,
  isExclusive,
  type JsOpenOptions,
  joined,
  MAX_IO,
  openRequest,
  readingInto,
  readingIntoAsync,
} from './js-io.ts';
import { JsCallError } from './js-kernel.ts';
import type { JsSyncFile } from './js-sync.ts';

export type DevStep<T> = Generator<SyncSabRequestBody, T, unknown>;

export const DEV_READ_MAX = 64 * 1024 * 1024;

const DEVICES: readonly string[] = ['null', 'zero', 'full', 'random', 'urandom'];
const STDIO: readonly string[] = ['stdin', 'stdout', 'stderr'];
const SELF_FD = '/proc/self/fd';
const S_IFMT = 0o170000;
const DIR = 0o040000;
const LINK = 0o120000;
const CHAR = 0o020000;
const BORN = Date.now();
const CHAR_KINDS: ReadonlySet<string | undefined> = new Set([
  'device',
  'tty',
  'clipboard',
  'embedder',
  'sealed',
]);

type DevNode =
  | { kind: 'dir'; mode: number }
  | { kind: 'device' }
  | { kind: 'tty' }
  | { kind: 'clipboard' }
  | { kind: 'embedder' }
  | { kind: 'sealed' }
  | { kind: 'terminal'; name: string; pts?: number }
  | { kind: 'serial'; node: DeviceNodeInfo }
  | { kind: 'devlink'; target: string; node: DeviceNodeInfo }
  | { kind: 'link'; target: string; fd?: number }
  | { kind: 'fd'; fd: number };

interface TtyOwner {
  uid: number;
  gid: number;
  mode?: number;
}

export function inDev(abs: string): boolean {
  return abs.startsWith('/dev') && (abs.length === 4 || abs[4] === '/') && !inShm(abs);
}

function missing(path: string): never {
  throw new JsCallError('ENOENT', path);
}

function nodeStat(mode: number, size = 0, owner?: { uid: number; gid: number }): SyncFsBridgeStat {
  return {
    isFile: false,
    isDirectory: (mode & S_IFMT) === DIR,
    isSymbolicLink: (mode & S_IFMT) === LINK,
    size,
    mode,
    mtimeMs: BORN,
    atimeMs: BORN,
    ctimeMs: BORN,
    nlink: 1,
    uid: owner?.uid ?? 0,
    gid: owner?.gid ?? 0,
  };
}

const SERIAL = '/dev/serial';

function serialNamed(name: string): boolean {
  return DEVICE_NAME.test(name) || name === 'serial' || name.startsWith('serial/');
}

function serialNode(abs: string, nodes: DeviceNodeInfo[]): DevNode | undefined {
  const node = nodes.find((n) => n.path === abs);
  if (node) return { kind: 'serial', node };
  const links = nodes.some((n) => n.links.length > 0);
  if (links && (abs === SERIAL || abs === BY_ID)) return { kind: 'dir', mode: DIR | 0o755 };
  const owner = nodes.find((n) => n.links.includes(abs));
  if (owner) return { kind: 'devlink', target: `../..${owner.path.slice(4)}`, node: owner };
  return undefined;
}

function* deviceNodes(): DevStep<DeviceNodeInfo[]> {
  return (yield { op: 'fd-dev-nodes' }) as DeviceNodeInfo[];
}

function* lookup(abs: string): DevStep<DevNode> {
  if (abs === '/dev') return { kind: 'dir', mode: DIR | 0o755 };
  const name = abs.slice('/dev/'.length);
  if (serialNamed(name)) {
    const found = serialNode(abs, yield* deviceNodes());
    if (found) return found;
  }
  if (DEVICES.includes(name)) return { kind: 'device' };
  if (name === 'tty') return { kind: 'tty' };
  if (name === 'clipboard') return { kind: 'clipboard' };
  if (name === 'embedder') return { kind: 'embedder' };
  if (name === 'sealed') return { kind: 'sealed' };
  const std = STDIO.indexOf(name);
  if (std >= 0) return { kind: 'link', target: `${SELF_FD}/${std}`, fd: std };
  if (name === 'fd') return { kind: 'link', target: SELF_FD };
  const fd = /^fd\/(\d+)$/.exec(name)?.[1];
  if (fd !== undefined) return { kind: 'fd', fd: Number(fd) };
  if (/^tty\d+$/.test(name)) {
    const names = (yield { op: 'fd-tty-names' }) as string[];
    if (names.includes(abs)) return { kind: 'terminal', name: abs };
  }
  if (name === 'pts') return { kind: 'dir', mode: DIR | 0o555 };
  const pts = /^pts\/(\d+)$/.exec(name)?.[1];
  if (pts !== undefined) {
    const open = (yield { op: 'pty-list' }) as number[];
    if (open.includes(Number(pts))) return { kind: 'terminal', name: abs, pts: Number(pts) };
  }
  return missing(abs);
}

function* fdInfo(fd: number, path: string): DevStep<FdInfo> {
  try {
    return (yield { op: 'fd-info', fd }) as FdInfo;
  } catch (err) {
    if (err instanceof JsCallError && err.code === 'EBADF') return missing(path);
    throw err;
  }
}

function* pathStat(path: string): DevStep<SyncFsBridgeStat> {
  const s = parseSyncFsStat(yield { op: 'stat', path });
  if (!s) throw new JsCallError('EIO', 'stat');
  return s;
}

function* terminalStat(name: string): DevStep<SyncFsBridgeStat> {
  const owner = (yield { op: 'fd-tty-owner', name }) as TtyOwner | null;
  if (owner) return nodeStat(CHAR | (owner.mode ?? 0o620), 0, owner);
  return nodeStat(CHAR | (name.startsWith('/dev/pts/') ? 0o620 : 0o666));
}

function* fdStat(fd: number, path: string): DevStep<SyncFsBridgeStat> {
  const info = yield* fdInfo(fd, path);
  if (info.meta && 'dir' in info.meta) return yield* pathStat(info.meta.dir);
  if (info.kind === 'file') {
    const file = (yield { op: 'fd-vfs-stat', fd }) as { path: string; size: number; orphan?: true };
    if (file.orphan) return { ...nodeStat(0o100600, file.size), isFile: true };
    const st = yield* pathStat(file.path);
    return { ...st, size: file.size };
  }
  if (info.terminal) return yield* terminalStat(info.terminal);
  if (CHAR_KINDS.has(info.kind)) return nodeStat(CHAR | 0o666);
  if (info.kind === 'socket') return nodeStat(0o140777);
  return nodeStat(0o010600);
}

function* fdTarget(fd: number, path: string): DevStep<string> {
  const info = yield* fdInfo(fd, path);
  if (info.meta && 'dir' in info.meta) return info.meta.dir;
  if (info.kind === 'file') return ((yield { op: 'fd-vfs-stat', fd }) as { path: string }).path;
  if (info.terminal) return info.terminal;
  if (info.meta && 'device' in info.meta) return `/dev/${(info.meta as DeviceMeta).device}`;
  if (info.kind === 'clipboard' || info.kind === 'sealed' || info.kind === 'embedder')
    return `/dev/${info.kind}`;
  return `${info.kind === 'socket' ? 'socket' : 'pipe'}:[${fd}]`;
}

export function devFdStat(fd: number): DevStep<SyncFsBridgeStat> {
  return fdStat(fd, `/dev/fd/${fd}`);
}

function serialStat(node: DeviceNodeInfo): SyncFsBridgeStat {
  return {
    ...nodeStat(CHAR | node.mode, 0, node),
    atimeMs: node.atimeMs,
    mtimeMs: node.mtimeMs,
    ctimeMs: node.ctimeMs,
  };
}

function linkStat(target: string): SyncFsBridgeStat {
  return nodeStat(LINK | 0o777, target.length);
}

export function* devStat(abs: string, follow: boolean): DevStep<SyncFsBridgeStat> {
  const node = yield* lookup(abs);
  switch (node.kind) {
    case 'dir':
      return nodeStat(node.mode);
    case 'device':
    case 'tty':
    case 'clipboard':
    case 'embedder':
    case 'sealed':
      return nodeStat(CHAR | 0o666);
    case 'terminal':
      return yield* terminalStat(node.name);
    case 'serial':
      return serialStat(node.node);
    case 'devlink':
      return follow ? serialStat(node.node) : linkStat(node.target);
    case 'link':
      if (!follow) return linkStat(node.target);
      return node.fd === undefined ? nodeStat(DIR | 0o555) : yield* fdStat(node.fd, abs);
    case 'fd':
      return follow ? yield* fdStat(node.fd, abs) : linkStat(yield* fdTarget(node.fd, abs));
  }
}

export function* devMeta(abs: string, follow: boolean, change: DeviceMetaChange): DevStep<boolean> {
  if (!abs.startsWith('/dev/') || !serialNamed(abs.slice(5))) return false;
  const found = serialNode(abs, yield* deviceNodes());
  if (found?.kind !== 'serial' && !(found?.kind === 'devlink' && follow)) return false;
  yield { op: 'fd-dev-meta', path: found.node.path, ...change };
  return true;
}

export async function devChangeAsync(
  kernel: { json(req: SyncSabRequestBody): Promise<unknown> },
  abs: string,
  change: DeviceMetaChange,
  plain: () => Promise<unknown>
): Promise<void> {
  if (await devAsync(kernel, devMeta(abs, true, change))) return;
  try {
    await plain();
  } catch (err) {
    const dev = err instanceof JsCallError && err.code === 'ENOENT' ? err.dev : undefined;
    if (dev === undefined || !(await devAsync(kernel, devMeta(dev, true, change)))) throw err;
  }
}

export function devChangeSync(
  kernel: { json(req: SyncSabRequestBody): unknown },
  abs: string,
  change: DeviceMetaChange,
  plain: () => unknown
): void {
  if (devSync(kernel, devMeta(abs, true, change))) return;
  try {
    plain();
  } catch (err) {
    const dev = err instanceof JsCallError && err.code === 'ENOENT' ? err.dev : undefined;
    if (dev === undefined || !devSync(kernel, devMeta(dev, true, change))) throw err;
  }
}

export function* devExists(abs: string): DevStep<boolean> {
  try {
    yield* devStat(abs, true);
    return true;
  } catch (err) {
    if (err instanceof JsCallError) return false;
    throw err;
  }
}

export function* devReadlink(abs: string): DevStep<string> {
  const node = yield* lookup(abs);
  if (node.kind === 'link' || node.kind === 'devlink') return node.target;
  if (node.kind === 'fd') return yield* fdTarget(node.fd, abs);
  throw new JsCallError('EINVAL', abs);
}

export function* devResolveTarget(abs: string): DevStep<string | undefined> {
  const node = yield* lookup(abs);
  if (node.kind === 'fd') return yield* fdTarget(node.fd, abs);
  if (node.kind === 'link' && node.fd !== undefined) return yield* fdTarget(node.fd, abs);
  return undefined;
}

export function* devReaddir(abs: string): DevStep<string[]> {
  if (abs === '/dev/fd') {
    const fds = (yield { op: 'fd-list' }) as Array<{ fd: number }>;
    return fds.map(({ fd }) => String(fd));
  }
  if (abs === '/dev/pts') {
    const open = (yield { op: 'pty-list' }) as number[];
    return open.map(String).sort();
  }
  const node = yield* lookup(abs);
  if (node.kind !== 'dir') throw new JsCallError('ENOTDIR', abs);
  if (abs === SERIAL || abs === BY_ID) {
    const nodes = yield* deviceNodes();
    if (abs === SERIAL) return ['by-id'];
    return nodes.flatMap((n) => n.links.map((l) => l.slice(BY_ID.length + 1))).sort();
  }
  const names = (yield { op: 'fd-tty-names' }) as string[];
  const ttys = names.filter((n) => /^\/dev\/tty\d+$/.test(n)).map((n) => n.slice(5));
  const nodes = yield* deviceNodes();
  const serial = nodes.map((n) => n.path.slice(5));
  if (nodes.some((n) => n.links.length > 0)) serial.push('serial');
  return [
    ...serial,
    ...DEVICES,
    'clipboard',
    'embedder',
    'sealed',
    'tty',
    'fd',
    'pts',
    'shm',
    ...STDIO,
    ...ttys,
  ].sort();
}

export interface DevOpened {
  fd: number;
  file: boolean;
  read: boolean;
  write: boolean;
  device?: boolean;
}

function* aliasOf(
  fd: number,
  abs: string,
  o: JsOpenOptions
): DevStep<Omit<DevOpened, 'read' | 'write'>> {
  const info = yield* fdInfo(fd, abs);
  const file = info.kind === 'file';
  if (file) {
    const at = (yield { op: 'fd-vfs-stat', fd }) as { path: string; size: number; orphan?: true };
    if (!at.orphan)
      return { fd: (yield openRequest(at.path, { ...o, create: false })) as number, file };
    const wantWrite = o.write === true || o.append === true || o.truncate === true;
    if (wantWrite && info.access === 'read') throw new JsCallError('EBADF', abs);
    if (!wantWrite && info.access === 'write') throw new JsCallError('EBADF', abs);
  }
  const copy = (yield { op: 'fd-dup', fd, min: 3 }) as number;
  if (file && o.truncate) {
    try {
      yield { op: 'fd-resize', fd: copy, size: 0 };
    } catch (err) {
      yield { op: 'fd-close', fd: copy };
      throw err;
    }
  }
  return { fd: copy, file };
}

function accessFlags(o: JsOpenOptions): number {
  const write = o.write === true || o.append === true || o.truncate === true;
  return write ? (o.read === true ? 2 : 1) : 0;
}

function* opened(abs: string, o: JsOpenOptions): DevStep<Omit<DevOpened, 'read' | 'write'>> {
  const node = yield* lookup(abs);
  if (isExclusive(o)) throw new JsCallError('EEXIST', abs);
  switch (node.kind) {
    case 'device':
      return { fd: (yield openRequest(abs, { ...o, create: false })) as number, file: false };
    case 'tty':
      return { fd: (yield { op: 'fd-open-tty' }) as number, file: false };
    case 'clipboard':
      return {
        fd: (yield { op: 'fd-open-clipboard', flags: accessFlags(o) }) as number,
        file: false,
      };
    case 'embedder':
      return {
        fd: (yield { op: 'fd-open-embedder', flags: accessFlags(o) }) as number,
        file: false,
      };
    case 'sealed':
      return { fd: (yield { op: 'fd-open-sealed', flags: accessFlags(o) }) as number, file: false };
    case 'serial':
    case 'devlink':
      return {
        fd: (yield { op: 'fd-open-dev', path: node.node.path, flags: accessFlags(o) }) as number,
        file: false,
        device: true,
      };
    case 'terminal': {
      const req =
        node.pts === undefined
          ? { op: 'fd-open-tty' as const, name: node.name }
          : { op: 'pty-slave-open' as const, n: node.pts, noctty: true };
      return { fd: (yield req) as number, file: false };
    }
    case 'fd':
      return yield* aliasOf(node.fd, abs, o);
    case 'link':
      if (node.fd !== undefined) return yield* aliasOf(node.fd, abs, o);
      throw new JsCallError('EISDIR', abs);
    case 'dir':
      throw new JsCallError('EISDIR', abs);
  }
}

export function* devOpen(abs: string, o: JsOpenOptions): DevStep<DevOpened> {
  const write = o.write === true || o.append === true || o.truncate === true;
  return { ...(yield* opened(abs, o)), read: o.read === true || !write, write };
}

export async function devAsync<T>(
  kernel: { json(req: SyncSabRequestBody): Promise<unknown> },
  step: DevStep<T>
): Promise<T> {
  let next = step.next();
  while (!next.done) {
    let answer: { value: unknown } | { error: unknown };
    try {
      answer = { value: await kernel.json(next.value) };
    } catch (error) {
      answer = { error };
    }
    next = 'value' in answer ? step.next(answer.value) : step.throw(answer.error);
  }
  return next.value;
}

export function devSync<T>(
  kernel: { json(req: SyncSabRequestBody): unknown },
  step: DevStep<T>
): T {
  let next = step.next();
  while (!next.done) {
    let answer: { value: unknown } | { error: unknown };
    try {
      answer = { value: kernel.json(next.value) };
    } catch (error) {
      answer = { error };
    }
    next = 'value' in answer ? step.next(answer.value) : step.throw(answer.error);
  }
  return next.value;
}

function tooLarge(got: number): void {
  if (got > DEV_READ_MAX) throw new JsCallError('EFBIG', 'readFile');
}

export interface StreamIo {
  read(fd: number, max: number): Promise<Uint8Array>;
  write(fd: number, data: Uint8Array): Promise<void>;
  close(fd: number): Promise<void>;
  ioctl?(fd: number, request: number, arg?: unknown): Promise<unknown>;
}

export interface StreamSyncIo {
  read(fd: number, max: number): Uint8Array;
  write(fd: number, data: Uint8Array): void;
  close(fd: number): void;
  ioctl?(fd: number, request: number, arg?: unknown): unknown;
}

export function ioctlRequest(fd: number, request: number, arg?: unknown): SyncSabRequestBody {
  return { op: 'fd-dev-ioctl', fd, request, ...(arg !== undefined ? { arg } : {}) };
}

export interface JsSerialTermios {
  c_iflag: number;
  c_oflag: number;
  c_cflag: number;
  c_lflag: number;
  c_cc: number[];
  ispeed: number;
  ospeed: number;
}

export interface JsModem {
  dtr: boolean;
  rts: boolean;
  cts: boolean;
  dsr: boolean;
  cd: boolean;
  ri: boolean;
}

export type JsTermiosWhen = 'now' | 'drain' | 'flush';

export type JsFlushQueue = 'input' | 'output' | 'both';

const WHEN: Readonly<Record<JsTermiosWhen, number>> = {
  now: IOCTL.TCSETS2,
  drain: IOCTL.TCSETSW2,
  flush: IOCTL.TCSETSF2,
};

const QUEUE: Readonly<Record<JsFlushQueue, number>> = { input: 0, output: 1, both: 2 };

function jsTermios(t: SerialTermios): JsSerialTermios {
  const { c_iflag, c_oflag, c_cflag, c_lflag, c_cc } = t;
  return {
    c_iflag,
    c_oflag,
    c_cflag,
    c_lflag,
    c_cc,
    ispeed: t.c_ispeed as number,
    ospeed: t.c_ospeed as number,
  };
}

function kernelTermios(t: JsSerialTermios): SerialTermios {
  const ospeed = speedArg(t?.ospeed);
  const ispeed = t.ispeed === undefined ? ospeed : speedArg(t.ispeed);
  const out = codeOf(ospeed);
  const cflag = ((Number(t.c_cflag) >>> 0) & ~(CBAUD | (CBAUD << 16))) | out;
  return {
    c_iflag: Number(t.c_iflag) >>> 0,
    c_oflag: Number(t.c_oflag) >>> 0,
    c_cflag: (ispeed === ospeed ? cflag : cflag | (codeOf(ispeed) << 16)) >>> 0,
    c_lflag: Number(t.c_lflag) >>> 0,
    c_cc: Array.from({ length: 32 }, (_, i) => Number(t.c_cc?.[i] ?? 0) & 0xff),
    c_ispeed: ispeed,
    c_ospeed: ospeed,
  };
}

function speedArg(speed: unknown): number {
  if (!Number.isInteger(speed) || (speed as number) < 0 || (speed as number) > 0xffffffff)
    throw new JsCallError('EINVAL', 'setTermios');
  return speed as number;
}

function modemOf(bits: unknown): JsModem {
  const b = Number(bits);
  return {
    dtr: (b & TIOCM.DTR) !== 0,
    rts: (b & TIOCM.RTS) !== 0,
    cts: (b & TIOCM.CTS) !== 0,
    dsr: (b & TIOCM.DSR) !== 0,
    cd: (b & TIOCM.CD) !== 0,
    ri: (b & TIOCM.RI) !== 0,
  };
}

function lines(m: { dtr?: boolean; rts?: boolean }, on: boolean): number {
  return (m?.dtr === on ? TIOCM.DTR : 0) | (m?.rts === on ? TIOCM.RTS : 0);
}

function serialControls(
  fd: number,
  live: () => void,
  ioctl: (fd: number, request: number, arg?: unknown) => unknown,
  then: (value: unknown, next: (value: unknown) => unknown) => unknown
): Record<string, (...args: never[]) => unknown> {
  const ask = (request: number, arg?: unknown): unknown => {
    live();
    return ioctl(fd, request, arg);
  };
  const none = (): undefined => undefined;
  return {
    termios: () => then(ask(IOCTL.TCGETS2), (t) => jsTermios(t as SerialTermios)),
    setTermios: (termios: JsSerialTermios, when: JsTermiosWhen = 'now') => {
      const request = WHEN[when];
      if (request === undefined) throw new JsCallError('EINVAL', 'setTermios');
      return then(ask(request, kernelTermios(termios)), none);
    },
    modem: () => then(ask(IOCTL.TIOCMGET), modemOf),
    setModem: (modem: { dtr?: boolean; rts?: boolean }) => {
      const on = lines(modem, true);
      const off = lines(modem, false);
      const clear = () => (off ? then(ask(IOCTL.TIOCMBIC, off), none) : undefined);
      return on ? then(ask(IOCTL.TIOCMBIS, on), clear) : then(clear(), none);
    },
    setBreak: (on: boolean) => then(ask(on ? IOCTL.TIOCSBRK : IOCTL.TIOCCBRK), none),
    sendBreak: () => then(ask(IOCTL.TCSBRK, 0), none),
    drain: () => then(ask(IOCTL.TCSBRK, 1), none),
    flush: (queue: JsFlushQueue = 'both') => {
      const n = QUEUE[queue];
      if (n === undefined) throw new JsCallError('EINVAL', 'flush');
      return then(ask(IOCTL.TCFLSH, n), none);
    },
  };
}

function liveness(path: string) {
  let open = true;
  return {
    live: (): void => {
      if (!open) throw new JsCallError('EBADF', path);
    },
    end: (): void => {
      open = false;
    },
  };
}

export interface StreamAccess {
  read: boolean;
  write: boolean;
  device?: boolean;
}

function allowed(may: boolean, what: string): void {
  if (!may) throw new JsCallError('EBADF', what);
}

export function streamFile(
  fd: number,
  path: string,
  io: StreamIo,
  access: StreamAccess
): { file: JsFile; invalidate: () => void } {
  const { live, end } = liveness(path);
  const readAsync = async (position: number, length: number): Promise<Uint8Array> => {
    index(position, 'read');
    index(length, 'read');
    live();
    allowed(access.read, 'read');
    return length === 0 ? new Uint8Array(0) : io.read(fd, Math.min(length, MAX_IO));
  };
  const file: JsFile = {
    fd,
    path,
    async size() {
      live();
      return 0;
    },
    read: (position, length) => readAsync(position, length),
    readInto: readingIntoAsync((position, length) => readAsync(position, length)),
    async write(position, data) {
      index(position, 'write');
      live();
      allowed(access.write, 'write');
      await io.write(fd, data);
      return data.length;
    },
    async truncate(size) {
      live();
      index(size, 'truncate');
      throw new JsCallError('EINVAL', 'truncate');
    },
    sync: async () => live(),
    async close() {
      live();
      end();
      await io.close(fd);
    },
  };
  if (access.device && io.ioctl) {
    const ioctl = io.ioctl;
    Object.assign(
      file,
      serialControls(fd, live, ioctl, (v, next) => Promise.resolve(v).then(next))
    );
  }
  return { file, invalidate: end };
}

export function streamSyncFile(
  fd: number,
  path: string,
  io: StreamSyncIo,
  access: StreamAccess
): { file: JsSyncFile; invalidate: () => void } {
  const { live, end } = liveness(path);
  const readSync = (position: number, length: number): Uint8Array => {
    index(position, 'read');
    index(length, 'read');
    live();
    allowed(access.read, 'read');
    return length === 0 ? new Uint8Array(0) : io.read(fd, Math.min(length, MAX_IO));
  };
  const file: JsSyncFile = {
    fd,
    path,
    size() {
      live();
      return 0;
    },
    read: (position, length) => readSync(position, length),
    readInto: readingInto((position, length) => readSync(position, length)),
    write(position, data) {
      index(position, 'write');
      live();
      allowed(access.write, 'write');
      io.write(fd, data);
      return data.length;
    },
    truncate(size) {
      live();
      index(size, 'truncate');
      throw new JsCallError('EINVAL', 'truncate');
    },
    sync: () => live(),
    close() {
      live();
      end();
      io.close(fd);
    },
  };
  if (access.device && io.ioctl)
    Object.assign(
      file,
      serialControls(fd, live, io.ioctl, (v, next) => next(v))
    );
  return { file, invalidate: end };
}

export async function readWhole(file: JsFile): Promise<Uint8Array> {
  try {
    const parts: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const chunk = await file.read(got, MAX_IO);
      if (chunk.length === 0) return joined(parts, got);
      got += chunk.length;
      tooLarge(got);
      parts.push(chunk);
    }
  } finally {
    await file.close();
  }
}

export function readWholeSync(file: JsSyncFile): Uint8Array {
  try {
    const parts: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const chunk = file.read(got, MAX_IO);
      if (chunk.length === 0) return joined(parts, got);
      got += chunk.length;
      tooLarge(got);
      parts.push(chunk);
    }
  } finally {
    file.close();
  }
}
