import type { DeviceMeta } from '../../kernel/fd-table.ts';
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
  'sealed',
]);

type DevNode =
  | { kind: 'dir'; mode: number }
  | { kind: 'device' }
  | { kind: 'tty' }
  | { kind: 'clipboard' }
  | { kind: 'sealed' }
  | { kind: 'terminal'; name: string; pts?: number }
  | { kind: 'link'; target: string; fd?: number }
  | { kind: 'fd'; fd: number };

interface TtyOwner {
  uid: number;
  gid: number;
  mode?: number;
}

export function inDev(abs: string): boolean {
  return abs.startsWith('/dev') && (abs.length === 4 || abs[4] === '/');
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

function* lookup(abs: string): DevStep<DevNode> {
  if (abs === '/dev') return { kind: 'dir', mode: DIR | 0o755 };
  const name = abs.slice('/dev/'.length);
  if (DEVICES.includes(name)) return { kind: 'device' };
  if (name === 'tty') return { kind: 'tty' };
  if (name === 'clipboard') return { kind: 'clipboard' };
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
    return yield* pathStat(file.path);
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
  if (info.kind === 'clipboard' || info.kind === 'sealed') return `/dev/${info.kind}`;
  return `${info.kind === 'socket' ? 'socket' : 'pipe'}:[${fd}]`;
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
    case 'sealed':
      return nodeStat(CHAR | 0o666);
    case 'terminal':
      return yield* terminalStat(node.name);
    case 'link':
      if (!follow) return linkStat(node.target);
      return node.fd === undefined ? nodeStat(DIR | 0o555) : yield* fdStat(node.fd, abs);
    case 'fd':
      return follow ? yield* fdStat(node.fd, abs) : linkStat(yield* fdTarget(node.fd, abs));
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
  if (node.kind === 'link') return node.target;
  if (node.kind === 'fd') return yield* fdTarget(node.fd, abs);
  throw new JsCallError('EINVAL', abs);
}

export function* devReaddir(abs: string): DevStep<string[]> {
  if (abs === '/dev/fd') {
    const fds = (yield { op: 'fd-list' }) as Array<{ fd: number }>;
    return fds.map(({ fd }) => String(fd));
  }
  const node = yield* lookup(abs);
  if (node.kind !== 'dir') throw new JsCallError('ENOTDIR', abs);
  const names = (yield { op: 'fd-tty-names' }) as string[];
  const ttys = names.filter((n) => /^\/dev\/tty\d+$/.test(n)).map((n) => n.slice(5));
  return [...DEVICES, 'clipboard', 'sealed', 'tty', 'fd', ...STDIO, ...ttys].sort();
}

export interface DevOpened {
  fd: number;
  file: boolean;
  read: boolean;
  write: boolean;
}

function* aliasOf(
  fd: number,
  abs: string,
  o: JsOpenOptions
): DevStep<Omit<DevOpened, 'read' | 'write'>> {
  const info = yield* fdInfo(fd, abs);
  const file = info.kind === 'file';
  if (file) {
    const at = (yield { op: 'fd-vfs-stat', fd }) as { path: string; orphan?: true };
    if (!at.orphan)
      return { fd: (yield openRequest(at.path, { ...o, create: false })) as number, file };
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
    case 'sealed':
      return { fd: (yield { op: 'fd-open-sealed', flags: accessFlags(o) }) as number, file: false };
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
}

export interface StreamSyncIo {
  read(fd: number, max: number): Uint8Array;
  write(fd: number, data: Uint8Array): void;
  close(fd: number): void;
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
  const file: JsFile = {
    fd,
    path,
    async size() {
      live();
      return 0;
    },
    async read(position, length) {
      index(position, 'read');
      index(length, 'read');
      live();
      allowed(access.read, 'read');
      return length === 0 ? new Uint8Array(0) : io.read(fd, Math.min(length, MAX_IO));
    },
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
  return { file, invalidate: end };
}

export function streamSyncFile(
  fd: number,
  path: string,
  io: StreamSyncIo,
  access: StreamAccess
): { file: JsSyncFile; invalidate: () => void } {
  const { live, end } = liveness(path);
  const file: JsSyncFile = {
    fd,
    path,
    size() {
      live();
      return 0;
    },
    read(position, length) {
      index(position, 'read');
      index(length, 'read');
      live();
      allowed(access.read, 'read');
      return length === 0 ? new Uint8Array(0) : io.read(fd, Math.min(length, MAX_IO));
    },
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
