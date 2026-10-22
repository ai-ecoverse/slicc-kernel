import {
  fileIdentity,
  type MountLine,
  mayTrace,
  type ProcessInfo,
  type ProcessListing,
} from '../../kernel/proc-info.ts';
import {
  type ChownArgs,
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
  sysEntry,
  sysText,
  systemFile,
  taskIds,
  taskStat,
} from '../procfs.ts';
import { normalize, SHARED_TTL_MS } from './wasi-files.ts';

export interface ProcSource {
  procList(): ProcessListing;
  mountList(): MountLine[];
}

type Node =
  | { kind: 'dir'; names: () => string[] }
  | { kind: 'link'; target: string; denied?: boolean; id?: string }
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
          'sys',
          'self',
          ...this.listing().processes.map((p) => String(p.pid)),
        ],
      };
    }
    if (top === 'sys') {
      const entry = sysEntry(parts.slice(1));
      if (typeof entry === 'string' || typeof entry === 'function') {
        return { kind: 'file', content: () => sysText(entry, () => this.listing()) };
      }
      return entry && { kind: 'dir', names: () => Object.keys(entry) };
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
    if (!/^[1-9]\d*$/.test(top) || !this.alive(Number(top))) return undefined;
    if (leaf === 'task') return this.task(Number(top), rest);
    if (rest.length > 0) return undefined;
    if (leaf === undefined) {
      const exe = () => (this.info(Number(top))?.exe === undefined ? [] : ['exe']);
      return { kind: 'dir', names: () => [...PID_NAMES, ...exe(), 'task'] };
    }
    if (leaf === 'exe') return this.exe(Number(top));
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

  private exe(pid: number): Node | undefined {
    const info = this.info(pid);
    if (info?.exe === undefined) return undefined;
    const denied = !mayTrace(this.ownInfo(), info);
    const id = info.exeId === undefined ? {} : { id: info.exeId };
    return { kind: 'link', target: info.exe, ...(denied ? { denied } : {}), ...id };
  }

  private ownInfo(): ProcessInfo | undefined {
    const processes = this.listing().processes;
    return processes.find((p) => p.tid === this.pid) ?? processes.find((p) => p.pid === this.pid);
  }

  private info(pid: number): ProcessInfo | undefined {
    return this.listing().processes.find((p) => p.pid === pid);
  }

  private task(pid: number, rest: string[]): Node | undefined {
    const [tid, leaf, ...more] = rest;
    const tids = () => taskIds(this.info(pid) as ProcessInfo);
    if (tid === undefined) return { kind: 'dir', names: () => tids().map(String) };
    if (!/^[1-9]\d*$/.test(tid) || more.length > 0 || !tids().includes(Number(tid)))
      return undefined;
    if (leaf === undefined) return { kind: 'dir', names: () => ['stat'] };
    if (leaf !== 'stat') return undefined;
    return {
      kind: 'file',
      content: () => {
        const listing = this.listing();
        const info = listing.processes.find((p) => p.pid === pid);
        const line = info && taskStat(info, Number(tid), listing.boot);
        if (line === undefined) throw syncError('ENOENT', `/proc/${pid}/task/${tid}/stat`);
        return line;
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

  escape(path: string): string | undefined {
    return this.escapeTo(path)?.target;
  }

  escapeTo(path: string): { target: string; id?: string } | undefined {
    const node = this.node(this.parts(path, true));
    if (node?.kind !== 'link' || !node.target.startsWith('/')) return undefined;
    if (node.denied) throw syncError('EACCES', path);
    return node.id === undefined ? { target: node.target } : { target: node.target, id: node.id };
  }

  linkTo(path: string): { target: string; id: string } | undefined {
    const node = this.node(this.parts(path, false));
    if (node?.kind !== 'link' || node.id === undefined || node.denied) return undefined;
    return { target: node.target, id: node.id };
  }

  readlink(path: string): string {
    const node = this.find(path, false);
    if (node.kind !== 'link') throw syncError('EINVAL', path);
    if (node.denied) throw syncError('EACCES', path);
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
const NOT_FOLLOWING = ['mkdir', 'rm', 'unlink', 'rmdir', 'lutimes', 'create', 'mkfifo'] as const;
const MAX_HOPS = 40;

type ProcRefusal = { refused: string };
type ProcWalk = Generator<
  { at: string; check: boolean },
  string | undefined | ProcRefusal,
  string | boolean | ProcRefusal
>;

function* procWalk(path: string, follow: boolean): ProcWalk {
  let done: string[] = [];
  let todo = path.split('/').filter((part) => part !== '');
  let hops = 0;
  let broken: ProcRefusal | undefined;
  while (todo.length > 0) {
    const part = todo.shift() as string;
    if (part === '.') continue;
    if (part === '..') {
      done.pop();
      continue;
    }
    const at = `/${[...done, part].join('/')}`;
    const whole = normalize(`/${[...done, part, ...todo].join('/')}`);
    if (inProc(at) && inProc(whole)) return broken ?? whole;
    if (!follow && todo.length === 0) return undefined;
    const target = yield { at, check: todo.find((next) => next !== '.') === '..' };
    if (typeof target === 'string') {
      if (++hops > MAX_HOPS) return undefined;
      [done, todo] = throughLink(target, done, todo);
    } else {
      broken ??= refusalOf(target);
      done.push(part);
    }
  }
  return undefined;
}

function failed(err: unknown): ProcRefusal {
  const code = (err as { code?: unknown } | null)?.code;
  return { refused: typeof code === 'string' ? code : 'ENOENT' };
}

function refusalOf(found: boolean | ProcRefusal): ProcRefusal | undefined {
  if (found === true) return undefined;
  return found === false ? { refused: 'ENOTDIR' } : found;
}

function throughLink(target: string, done: string[], todo: string[]): [string[], string[]] {
  const parts = target.split('/').filter((part) => part !== '');
  return [target.startsWith('/') ? [] : done, [...parts, ...todo]];
}

function procPath(
  fs: Pick<SyncFsPosixBridge, 'lstat' | 'readlink'>,
  path: string,
  follow: boolean
): string | undefined {
  const walk = procWalk(path, follow);
  let step = walk.next();
  while (!step.done) {
    const { at, check } = step.value;
    let target: string | boolean | ProcRefusal;
    try {
      const st = fs.lstat(at);
      target = st.isSymbolicLink ? fs.readlink(at) : !check || st.isDirectory;
    } catch (err) {
      target = failed(err);
    }
    step = walk.next(target);
  }
  const result = step.value;
  if (typeof result === 'object') throw syncError(result.refused, path);
  return result;
}

export async function procAlias(
  fs: { readlink?(path: string): Promise<string>; lstat?(path: string): Promise<unknown> },
  path: string,
  follow: boolean
): Promise<string | undefined | ProcRefusal> {
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
    const { at, check } = step.value;
    const link = await readlink.call(fs, at).catch(() => undefined);
    const isDir = (st: unknown) => (st as { isDirectory?: boolean }).isDirectory === true;
    const target = link ?? (check ? await lstat.call(fs, at).then(isDir, failed) : true);
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

export function physicalProc(
  fs: Pick<SyncFsPosixBridge, 'stat' | 'changes'>,
  now: () => number = () => performance.now()
): () => boolean {
  const view = fs.changes;
  let seen: { gen: number; physical: boolean; at: number } | undefined;
  return () => {
    if (seen && view && (!view.foreign() || now() - seen.at < SHARED_TTL_MS)) {
      const proc = view.changedSince(seen.gen, '/proc');
      if (!proc.changed && !view.changedSince(seen.gen, '/').changed) {
        seen.gen = proc.now;
        return seen.physical;
      }
    }
    const gen = view?.now();
    const at = now();
    let physical: boolean;
    try {
      fs.stat('/proc');
      physical = true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        seen = undefined;
        return false;
      }
      physical = false;
    }
    seen = gen === undefined ? undefined : { gen, physical, at };
    return physical;
  };
}

function directMiss(err: unknown, path: string): boolean {
  if ((err as { direct?: unknown } | null)?.direct !== true) return false;
  return !path.split('/').some((part) => part === '.' || part === '..');
}

const GONE = new Set(['ENOENT', 'ENOTDIR']);

function same(fs: SyncFsPosixBridge, path: string, id: string): boolean {
  let st: ReturnType<SyncFsPosixBridge['stat']>;
  try {
    st = fs.stat(path);
  } catch (err) {
    if (GONE.has((err as { code?: string } | null)?.code ?? '')) return false;
    throw err;
  }
  const now = fileIdentity(st.ino, st.mtimeMs);
  return now === undefined || now === id;
}

function current(fs: SyncFsPosixBridge, tree: ProcTree, q: string): string | undefined {
  const to = tree.escapeTo(q);
  if (!to || to.id === undefined) return to?.target;
  if (!same(fs, to.target, to.id)) throw syncError('ENOENT', q);
  return to.target;
}

function guard(
  toProc: (path: string, follow: boolean) => string | undefined,
  shadowing: () => boolean
) {
  return <R>(paths: Array<[string, boolean]>, run: () => R): R => {
    const physical = shadowing();
    for (const [p, follow] of paths) {
      if (inProc(p) || (physical && toProc(p, follow) !== undefined)) throw syncError('EROFS', p);
    }
    return run();
  };
}

function shownLink(fs: SyncFsPosixBridge, tree: ProcTree, q: string): string {
  const target = tree.readlink(q);
  const to = tree.linkTo(q);
  if (!to) return target;
  try {
    return same(fs, to.target, to.id) ? target : `${target} (deleted)`;
  } catch {
    return target;
  }
}

function routing(
  fs: SyncFsPosixBridge,
  tree: ProcTree,
  toProc: (path: string, follow: boolean) => string | undefined,
  shadowing: () => boolean
) {
  return <R>(
    p: string,
    inner: (q: string) => R,
    own: () => R,
    follow = true,
    outside?: (target: string) => R
  ): R => {
    const proc = (q: string): R => {
      const target = outside ? current(fs, tree, q) : undefined;
      return target === undefined ? inner(q) : (outside as (t: string) => R)(target);
    };
    if (inProc(p)) return proc(p);
    if (shadowing()) {
      const real = toProc(p, follow);
      if (real !== undefined) return proc(real);
    }
    try {
      return own();
    } catch (err) {
      if (directMiss(err, p)) throw err;
      const real = toProc(p, follow);
      if (real === undefined) throw err;
      return proc(real);
    }
  };
}

export function procfsBridge<T extends SyncFsPosixBridge>(fs: T, tree: ProcTree): T {
  const toProc = (path: string, follow: boolean) => procPath(fs, path, follow);
  const shadowing = physicalProc(fs);
  const via = routing(fs, tree, toProc, shadowing);
  const readOnly = guard(toProc, shadowing);
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
        () => fs.readFile(p),
        true,
        (t) => fs.readFile(t)
      ),
    stat: (p: string) =>
      via(
        p,
        (q) => tree.stat(q),
        () => fs.stat(p),
        true,
        (t) => ({ ...fs.stat(t), escape: t })
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
      const probe = () => {
        try {
          return toProc(p, true);
        } catch {
          return null;
        }
      };
      const real = shadowing() ? probe() : undefined;
      if (real === null) return false;
      if (real !== undefined) return tree.exists(real);
      try {
        fs.stat(p);
        return true;
      } catch (err) {
        if (directMiss(err, p)) return false;
      }
      const late = probe();
      return typeof late === 'string' && tree.exists(late);
    },
    readlink: (p: string) =>
      via(
        p,
        (q) => shownLink(fs, tree, q),
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
    link: (from: string, to: string, follow?: boolean) =>
      readOnly(
        [
          [from, follow === true],
          [to, false],
        ],
        () => fs.link(from, to, follow)
      ),
    hold: (
      p: string,
      held: boolean,
      open?: boolean,
      handle?: number,
      want?: number,
      seen?: { gen?: number; nofollow?: boolean }
    ) => {
      if (handle !== undefined && snapshots.delete(handle)) return undefined;
      if (!held) return fs.hold?.(p, held, open, handle);
      return via(p, snapshot, () => fs.hold?.(p, held, open, undefined, want, seen) ?? late(p));
    },
    kept: (handle: number) => snapshots.has(handle) || fs.kept?.(handle) === true,
    escape: (p: string) => (inProc(p) ? current(fs, tree, p) : undefined),
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
  const { chown } = fs;
  if (chown) {
    over.chown = (p: string, ...rest: ChownArgs) =>
      readOnly([[p, rest[2] === true]], () => chown.call(fs, p, ...rest));
  }
  return new Proxy(fs, {
    get: (target, key, receiver) =>
      key in over ? over[key as keyof SyncFsPosixBridge] : Reflect.get(target, key, receiver),
  });
}
