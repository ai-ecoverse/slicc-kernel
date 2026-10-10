import type { MountLine, ProcessListing } from '../../kernel/proc-info.ts';
import {
  type SyncFsBridgeStat,
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

const READ_ONLY = [
  'writeFile',
  'mkdir',
  'rm',
  'unlink',
  'rmdir',
  'symlink',
  'chmod',
  'utimes',
  'lutimes',
  'create',
  'pwrite',
  'truncate',
] as const;

export function procfsBridge<T extends SyncFsPosixBridge>(fs: T, tree: ProcTree): T {
  const over: Partial<Record<keyof SyncFsPosixBridge, unknown>> = {
    readFile: (p: string) => (inProc(p) ? tree.read(p) : fs.readFile(p)),
    stat: (p: string) => (inProc(p) ? tree.stat(p) : fs.stat(p)),
    lstat: (p: string) => (inProc(p) ? tree.stat(p, false) : fs.lstat(p)),
    readdir: (p: string) => {
      if (inProc(p)) return tree.readdir(p);
      const names = fs.readdir(p);
      return p === '/' && !names.includes('proc') ? [...names, 'proc'] : names;
    },
    exists: (p: string) => (inProc(p) ? tree.exists(p) : fs.exists(p)),
    readlink: (p: string) => (inProc(p) ? tree.readlink(p) : fs.readlink(p)),
    readdirStat: (p: string) => {
      if (!inProc(p)) {
        const listed = fs.readdirStat(p);
        if (p !== '/' || listed.some(([name]) => name === 'proc')) return listed;
        return [...listed, ['proc', tree.stat('/proc')] as [string, SyncFsBridgeStat]];
      }
      return tree.readdir(p).map((name): [string, SyncFsBridgeStat | null] => {
        try {
          return [name, tree.stat(`${p}/${name}`, false)];
        } catch {
          return [name, null];
        }
      });
    },
    rename: (from: string, to: string) => {
      if (inProc(from) || inProc(to)) throw syncError('EROFS', from);
      fs.rename(from, to);
    },
    hold: (p: string, ...rest: [boolean, boolean?, number?]) =>
      inProc(p) ? undefined : fs.hold?.(p, ...rest),
    ...(fs.pread
      ? {
          pread: (p: string, at: number, n: number, version?: string) =>
            inProc(p)
              ? tree.read(p).subarray(at, at + n)
              : (fs.pread as NonNullable<T['pread']>)(p, at, n, version),
        }
      : {}),
  };
  for (const name of READ_ONLY) {
    const fn = fs[name] as ((p: string, ...rest: unknown[]) => unknown) | undefined;
    if (!fn) continue;
    over[name] = (p: string, ...rest: unknown[]) => {
      if (inProc(p)) throw syncError('EROFS', p);
      return fn.call(fs, p, ...rest);
    };
  }
  return new Proxy(fs, {
    get: (target, key, receiver) =>
      key in over ? over[key as keyof SyncFsPosixBridge] : Reflect.get(target, key, receiver),
  });
}
