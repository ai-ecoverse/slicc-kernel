import type { MountLine, ProcessListing } from '../../kernel/proc-info.ts';
import {
  type SyncFsBridgeStat,
  type SyncFsFileIo,
  type SyncFsPosixBridge,
  syncError,
} from '../../realm/sync-fs-wire.ts';
import { mountTable } from '../process-fds.ts';
import {
  type MemorySource,
  memorySource,
  PID_FILES,
  pidFile,
  SYSTEM_FILES,
  systemFile,
} from '../procfs.ts';
import { normalize } from './wasi-files.ts';

export interface ProcSource {
  procList(): ProcessListing;
  mountList(): MountLine[];
}

type Node =
  | { kind: 'dir'; names: () => string[] }
  | { kind: 'link'; target: string }
  | { kind: 'file'; content: () => string };

const DIR_MODE = 0o40555;
const FILE_MODE = 0o100444;
const LINK_MODE = 0o120777;

const PID_NAMES: readonly string[] = PID_FILES;
const SYSTEM_NAMES: readonly string[] = SYSTEM_FILES;

export function inProc(path: string): boolean {
  return path === '/proc' || path.startsWith('/proc/');
}

export class ProcTree {
  private readonly source: ProcSource;
  private readonly pid: number;
  private readonly memory: MemorySource;

  constructor(source: ProcSource, pid: number, memory: MemorySource = memorySource()) {
    this.source = source;
    this.pid = pid;
    this.memory = memory;
  }

  private listing(): ProcessListing {
    return this.source.procList();
  }

  private alive(pid: number): boolean {
    return this.listing().processes.some((p) => p.pid === pid);
  }

  private node(parts: string[]): Node | undefined {
    const [top, leaf, ...rest] = parts;
    if (top === undefined) {
      return {
        kind: 'dir',
        names: () => [
          ...SYSTEM_NAMES,
          'mounts',
          'self',
          ...this.listing().processes.map((p) => String(p.pid)),
        ],
      };
    }
    if (top === 'self') {
      return leaf === undefined ? { kind: 'link', target: String(this.pid) } : undefined;
    }
    if (leaf === undefined && top === 'mounts') {
      return { kind: 'file', content: () => mountTable(this.source.mountList()) };
    }
    if (leaf === undefined && SYSTEM_NAMES.includes(top)) {
      return {
        kind: 'file',
        content: () =>
          systemFile(top as (typeof SYSTEM_FILES)[number], this.listing(), Date.now(), this.memory),
      };
    }
    if (!/^[1-9]\d*$/.test(top) || rest.length > 0 || !this.alive(Number(top))) return undefined;
    if (leaf === undefined) return { kind: 'dir', names: () => [...PID_NAMES] };
    if (!PID_NAMES.includes(leaf)) return undefined;
    return {
      kind: 'file',
      content: () => {
        const listing = this.listing();
        const info = listing.processes.find((p) => p.pid === Number(top));
        if (!info) throw syncError('ENOENT', `/proc/${top}/${leaf}`);
        return pidFile(leaf as (typeof PID_FILES)[number], info, listing.boot);
      },
    };
  }

  private parts(path: string, follow: boolean): string[] {
    const parts = path
      .split('/')
      .filter((p) => p !== '')
      .slice(1);
    if (parts[0] === 'self' && (follow || parts.length > 1)) parts[0] = String(this.pid);
    return parts;
  }

  private find(path: string, follow: boolean): Node {
    const node = this.node(this.parts(path, follow));
    if (!node) throw syncError('ENOENT', path);
    return node;
  }

  stat(path: string, follow = true): SyncFsBridgeStat {
    const node = this.find(path, follow);
    const base = {
      isFile: false,
      isDirectory: false,
      size: 0,
      mtimeMs: Date.now(),
      readonly: true,
    };
    if (node.kind === 'dir') return { ...base, isDirectory: true, mode: DIR_MODE };
    if (node.kind === 'link') {
      return { ...base, isSymbolicLink: true, mode: LINK_MODE, size: node.target.length };
    }
    return { ...base, isFile: true, mode: FILE_MODE, size: this.bytes(node).length };
  }

  private bytes(node: Node): Uint8Array {
    return new TextEncoder().encode(node.kind === 'file' ? node.content() : '');
  }

  read(path: string): Uint8Array {
    const node = this.find(path, true);
    if (node.kind !== 'file') throw syncError('EISDIR', path);
    return this.bytes(node);
  }

  readdir(path: string): string[] {
    const node = this.find(path, true);
    if (node.kind !== 'dir') throw syncError('ENOTDIR', path);
    return node.names();
  }

  readlink(path: string): string {
    const node = this.find(path, false);
    if (node.kind !== 'link') throw syncError('EINVAL', path);
    return node.target;
  }

  exists(path: string): boolean {
    try {
      this.find(path, true);
      return true;
    } catch {
      return false;
    }
  }
}

const FOLLOWING = ['writeFile', 'chmod', 'utimes', 'pwrite', 'truncate'] as const;
const NOT_FOLLOWING = ['mkdir', 'rm', 'unlink', 'rmdir', 'lutimes', 'create'] as const;
const MAX_HOPS = 40;

type ProcWalk = Generator<string, string | undefined, string | null | undefined>;

function* procWalk(path: string, follow: boolean): ProcWalk {
  let done: string[] = [];
  let todo = path.split('/').filter((part) => part !== '');
  let hops = 0;
  while (todo.length > 0) {
    const part = todo.shift() as string;
    if (part === '.') continue;
    if (part === '..') {
      done.pop();
      continue;
    }
    const at = `/${[...done, part].join('/')}`;
    const whole = normalize(`/${[...done, part, ...todo].join('/')}`);
    if (inProc(at) && inProc(whole)) return whole;
    if (!follow && todo.length === 0) return undefined;
    const target = yield at;
    if (target === null) return undefined;
    if (target === undefined) done.push(part);
    else {
      if (++hops > MAX_HOPS) return undefined;
      if (target.startsWith('/')) done = [];
      todo = [...target.split('/').filter((part) => part !== ''), ...todo];
    }
  }
  return undefined;
}

function procPath(
  fs: Pick<SyncFsPosixBridge, 'lstat' | 'readlink'>,
  path: string,
  follow: boolean
): string | undefined {
  const walk = procWalk(path, follow);
  let step = walk.next();
  while (!step.done) {
    let target: string | null | undefined;
    try {
      target = fs.lstat(step.value).isSymbolicLink ? fs.readlink(step.value) : undefined;
    } catch {
      target = null;
    }
    step = walk.next(target);
  }
  return step.value;
}

export async function procAlias(
  fs: { readlink?(path: string): Promise<string>; lstat?(path: string): Promise<unknown> },
  path: string,
  follow: boolean
): Promise<string | undefined> {
  const { readlink, lstat } = fs;
  if (!readlink || !lstat) return undefined;
  const physical = await lstat.call(fs, '/proc').then(
    () => true,
    () => false
  );
  if (!physical) return undefined;
  const walk = procWalk(path, follow);
  let step = walk.next();
  while (!step.done) {
    const target = await readlink.call(fs, step.value).catch(() => undefined);
    step = walk.next(target);
  }
  return step.value;
}

function frozen(bytes: Uint8Array): SyncFsFileIo {
  const refuse = (): never => {
    throw syncError('EROFS', '/proc');
  };
  return {
    readFile: () => bytes,
    pread: (_p: string, at: number, n: number) => bytes.subarray(at, at + n),
    writeFile: refuse,
    pwrite: refuse,
    truncate: refuse,
  };
}

export function procfsBridge<T extends SyncFsPosixBridge>(fs: T, tree: ProcTree): T {
  const toProc = (path: string, follow: boolean) => procPath(fs, path, follow);
  const shadowing = (): boolean => {
    try {
      return fs.exists('/proc');
    } catch {
      return false;
    }
  };
  const via = <R>(p: string, proc: (q: string) => R, own: () => R, follow = true): R => {
    if (inProc(p)) return proc(p);
    if (shadowing()) {
      const real = toProc(p, follow);
      if (real !== undefined) return proc(real);
    }
    try {
      return own();
    } catch (err) {
      const real = toProc(p, follow);
      if (real === undefined) throw err;
      return proc(real);
    }
  };
  const readOnly = <R>(paths: Array<[string, boolean]>, run: () => R): R => {
    const physical = shadowing();
    for (const [p, follow] of paths) {
      if (inProc(p) || (physical && toProc(p, follow) !== undefined)) throw syncError('EROFS', p);
    }
    return run();
  };
  const snapshots = new Map<number, Uint8Array>();
  let lastSnapshot = 0;
  const snapshot = (q: string): number => {
    lastSnapshot--;
    snapshots.set(lastSnapshot, tree.read(q));
    return lastSnapshot;
  };
  const late = (p: string): number | undefined => {
    const q = toProc(p, true);
    return q === undefined ? undefined : snapshot(q);
  };
  const over: Partial<Record<keyof SyncFsPosixBridge, unknown>> = {
    readFile: (p: string) =>
      via(
        p,
        (q) => tree.read(q),
        () => fs.readFile(p)
      ),
    stat: (p: string) =>
      via(
        p,
        (q) => tree.stat(q),
        () => fs.stat(p)
      ),
    lstat: (p: string) =>
      via(
        p,
        (q) => tree.stat(q, false),
        () => fs.lstat(p),
        false
      ),
    readdir: (p: string) =>
      via(
        p,
        (q) => tree.readdir(q),
        () => {
          const names = fs.readdir(p);
          return p === '/' && !names.includes('proc') ? [...names, 'proc'] : names;
        }
      ),
    exists: (p: string) => {
      if (inProc(p)) return tree.exists(p);
      const real = shadowing() ? toProc(p, true) : undefined;
      if (real !== undefined) return tree.exists(real);
      if (fs.exists(p)) return true;
      const late = toProc(p, true);
      return late !== undefined && tree.exists(late);
    },
    readlink: (p: string) =>
      via(
        p,
        (q) => tree.readlink(q),
        () => fs.readlink(p),
        false
      ),
    readdirStat: (p: string) =>
      via(
        p,
        (q) =>
          tree.readdir(q).map((name): [string, SyncFsBridgeStat | null] => {
            try {
              return [name, tree.stat(`${q}/${name}`, false)];
            } catch {
              return [name, null];
            }
          }),
        () => {
          const listed = fs.readdirStat(p);
          if (p !== '/' || listed.some(([name]) => name === 'proc')) return listed;
          return [...listed, ['proc', tree.stat('/proc')] as [string, SyncFsBridgeStat]];
        }
      ),
    rename: (from: string, to: string) =>
      readOnly(
        [
          [from, false],
          [to, false],
        ],
        () => fs.rename(from, to)
      ),
    symlink: (target: string, link: string) =>
      readOnly([[link, false]], () => fs.symlink(target, link)),
    hold: (p: string, held: boolean, open?: boolean, handle?: number) => {
      if (handle !== undefined && snapshots.delete(handle)) return undefined;
      if (!held) return fs.hold?.(p, held, open, handle);
      return via(p, snapshot, () => fs.hold?.(p, held, open) ?? late(p));
    },
    kept: (handle: number) => snapshots.has(handle) || fs.kept?.(handle) === true,
    pinned: (handle: number) => {
      const bytes = snapshots.get(handle);
      return bytes ? frozen(bytes) : (fs.pinned?.(handle) ?? fs);
    },
    ...(fs.pread
      ? {
          pread: (p: string, at: number, n: number, version?: string) =>
            via(
              p,
              (q) => tree.read(q).subarray(at, at + n),
              () => (fs.pread as NonNullable<T['pread']>)(p, at, n, version)
            ),
        }
      : {}),
  };
  for (const [names, follow] of [
    [FOLLOWING, true],
    [NOT_FOLLOWING, false],
  ] as const) {
    for (const name of names) {
      const fn = fs[name] as ((p: string, ...rest: unknown[]) => unknown) | undefined;
      if (!fn) continue;
      over[name] = (p: string, ...rest: unknown[]) =>
        readOnly([[p, follow]], () => fn.call(fs, p, ...rest));
    }
  }
  return new Proxy(fs, {
    get: (target, key, receiver) =>
      key in over ? over[key as keyof SyncFsPosixBridge] : Reflect.get(target, key, receiver),
  });
}
