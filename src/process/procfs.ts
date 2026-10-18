import { ROOT } from '../kernel/cred.ts';
import type { MountLine, ProcessInfo, ProcessListing } from '../kernel/proc-info.ts';
import { OS_RELEASE, procVersion } from '../version.ts';
import { mountTable } from './process-fds.ts';

const HZ = 100;
const DIR_MODE = 0o40555;
const FILE_MODE = 0o100444;
const LINK_MODE = 0o120777;
const ENOENT = 44;
const EINVAL = 28;
const UID = 1000;
const KIB = 1024;
const FALLBACK_MEMORY = 4 * KIB * KIB * KIB;

export const PID_FILES = ['cmdline', 'comm', 'stat', 'statm', 'status'] as const;
export const SYSTEM_FILES = ['loadavg', 'meminfo', 'stat', 'uptime', 'version'] as const;

export type ProcSysFile = string | ((listing: ProcessListing) => string);

export interface ProcSysTree {
  readonly [name: string]: ProcSysFile | ProcSysTree;
}

export const SYS_TREE: ProcSysTree = {
  kernel: {
    osrelease: `${OS_RELEASE}\n`,
    ostype: 'Linux\n',
    slicc_wasm_memories: (listing) =>
      `${listing.wasm?.live ?? 0} ${listing.wasm?.ceiling ?? 0} ${listing.wasm?.source ?? 'none'}\n`,
    slicc_shared_root: (listing) => `${listing.peers ?? 0}\n`,
    slicc_fs_calls: (listing) => `${listing.fsCalls ?? 0}\n`,
  },
};

function isSysFile(at: ProcSysFile | ProcSysTree): at is ProcSysFile {
  return typeof at === 'string' || typeof at === 'function';
}

export function sysEntry(parts: readonly string[]): ProcSysFile | ProcSysTree | undefined {
  let at: ProcSysFile | ProcSysTree | undefined = SYS_TREE;
  for (const part of parts) {
    if (isSysFile(at) || !Object.hasOwn(at, part)) return undefined;
    at = at[part];
  }
  return at;
}

export function sysText(file: ProcSysFile, listing: () => ProcessListing): string {
  return typeof file === 'string' ? file : file(listing());
}

type PidFile = (typeof PID_FILES)[number];
type SystemFile = (typeof SYSTEM_FILES)[number];

export interface ProcSys {
  procList?(): ProcessListing;
  mountList?(): MountLine[];
}

export interface MemorySource {
  deviceMemory?: number;
  usedHeap?: number;
}

export function commOf(info: ProcessInfo): string {
  const name = info.argv[0] ?? '';
  return name.slice(name.lastIndexOf('/') + 1).slice(0, 15);
}

export function ttyNumber(tty: string | null): number {
  const pts = tty && /^\/dev\/pts\/(\d+)$/.exec(tty);
  if (pts) return (136 << 8) | Number(pts[1]);
  const vt = tty && /^\/dev\/tty(\d+)$/.exec(tty);
  return vt ? (4 << 8) | Number(vt[1]) : 0;
}

function pages(bytes: number): number {
  return Math.ceil(bytes / 4096);
}

function ticks(ms: number): number {
  return Math.max(0, Math.floor((ms * HZ) / 1000));
}

export function pidStat(info: ProcessInfo, boot: number, state: string = info.state): string {
  const fields = [
    info.pid,
    `(${commOf(info)})`,
    state,
    info.ppid,
    info.pgid,
    info.sid,
    ttyNumber(info.tty),
    info.tty ? info.pgid : -1,
    0x400000,
    0,
    0,
    0,
    0,
    ticks(info.utime ?? 0),
    ticks(info.stime ?? 0),
    ticks(info.cutime ?? 0),
    ticks(info.cstime ?? 0),
    20,
    0,
    1,
    0,
    ticks(info.started - boot),
    info.memory,
    pages(info.memory),
    '18446744073709551615',
    ...Array<number>(12).fill(0),
    17,
    0,
    0,
    0,
    0,
    0,
    0,
    ...Array<number>(7).fill(0),
    0,
  ];
  return `${fields.join(' ')}\n`;
}

const sigMask = (mask = 0): string => (mask >>> 1).toString(16).padStart(16, '0');

const STATES = {
  S: 'S (sleeping)',
  T: 'T (stopped)',
  Z: 'Z (zombie)',
} as const;

const tagLine = (tag: string): string =>
  `Tag:\t${tag.replaceAll('\n', '\\n').replaceAll('\t', '\\t').replaceAll('\r', '\\r')}`;

export function taskStat(info: ProcessInfo, tid: number, boot: number): string | undefined {
  const thread = (info.threads ?? [{ tid: 1, state: info.state }]).find((t) => t.tid === tid);
  return thread && pidStat({ ...info, pid: tid }, boot, thread.state);
}

export function taskIds(info: ProcessInfo): number[] {
  return (info.threads ?? [{ tid: 1 }]).map((t) => t.tid);
}

export function pidStatus(info: ProcessInfo): string {
  const state = STATES[info.state];
  const c = info.cred ?? ROOT;
  const ids = (r: number, e: number, s: number) => `${r}\t${e}\t${s}\t${e}`;
  return [
    `Name:\t${commOf(info)}`,
    `Umask:\t${(info.umask ?? 0o022).toString(8).padStart(4, '0')}`,
    `State:\t${state}`,
    `Tgid:\t${info.pid}`,
    'Ngid:\t0',
    `Pid:\t${info.pid}`,
    `PPid:\t${info.ppid}`,
    'TracerPid:\t0',
    `Uid:\t${ids(c.ruid, c.euid, c.suid)}`,
    `Gid:\t${ids(c.rgid, c.egid, c.sgid)}`,
    ...(info.tag !== undefined ? [tagLine(info.tag)] : []),
    'FDSize:\t64',
    `VmSize:\t${Math.ceil(info.memory / KIB)} kB`,
    `VmRSS:\t${Math.ceil(info.memory / KIB)} kB`,
    `Groups:\t${c.groups.join(' ')}`,
    `NSpid:\t${info.pid}`,
    `NSpgid:\t${info.pgid}`,
    `NSsid:\t${info.sid}`,
    'Threads:\t1',
    'SigQ:\t0/0',
    'SigPnd:\t0000000000000000',
    'ShdPnd:\t0000000000000000',
    `SigBlk:\t${sigMask(info.sigBlk)}`,
    `SigIgn:\t${sigMask(info.sigIgn)}`,
    `SigCgt:\t${sigMask(info.sigCgt)}`,
    '',
  ].join('\n');
}

export function pidFile(name: PidFile, info: ProcessInfo, boot: number): string {
  if (name === 'cmdline') return info.state === 'Z' ? '' : `${info.argv.join('\0')}\0`;
  if (name === 'comm') return `${commOf(info)}\n`;
  if (name === 'stat') return pidStat(info, boot);
  if (name === 'statm') {
    const p = pages(info.memory);
    return `${p} ${p} 0 0 0 ${p} 0\n`;
  }
  return pidStatus(info);
}

export function memoryInfo(source: MemorySource, used = 0): string {
  const total = source.deviceMemory ? source.deviceMemory * KIB * KIB * KIB : FALLBACK_MEMORY;
  const free = Math.max(0, total - used - (source.usedHeap ?? 0));
  const kb = (bytes: number) => `${Math.floor(bytes / KIB)} kB`;
  return [
    ['MemTotal', kb(total)],
    ['MemFree', kb(free)],
    ['MemAvailable', kb(free)],
    ['Buffers', kb(0)],
    ['Cached', kb(0)],
    ['SwapCached', kb(0)],
    ['Shmem', kb(0)],
    ['SReclaimable', kb(0)],
    ['SwapTotal', kb(0)],
    ['SwapFree', kb(0)],
  ]
    .map(([key, value]) => `${`${key}:`.padEnd(16)}${value.padStart(12)}`)
    .concat('')
    .join('\n');
}

export function systemFile(
  name: SystemFile,
  listing: ProcessListing,
  now: number,
  memory: MemorySource
): string {
  if (name === 'version') return procVersion();
  const up = Math.max(0, now - listing.boot) / 1000;
  if (name === 'uptime') return `${up.toFixed(2)} ${up.toFixed(2)}\n`;
  if (name === 'meminfo') {
    return memoryInfo(
      memory,
      listing.processes.reduce((sum, p) => sum + p.memory, 0)
    );
  }
  const live = listing.processes.filter((p) => p.state !== 'Z');
  if (name === 'loadavg') {
    const last = Math.max(0, ...listing.processes.map((p) => p.pid));
    const [one, five, fifteen] = (listing.load ?? [0, 0, 0]).map((n) => n.toFixed(2));
    return `${one} ${five} ${fifteen} 1/${live.length} ${last}\n`;
  }
  const sum = (key: 'utime' | 'stime') =>
    listing.cpu?.[key] ?? listing.processes.reduce((n, p) => n + (p[key] ?? 0), 0);
  const user = ticks(sum('utime'));
  const system = ticks(sum('stime'));
  const idle = listing.cpu
    ? ticks(listing.cpu.idle)
    : Math.max(0, ticks(now - listing.boot) - user - system);
  return [
    `cpu  ${user} 0 ${system} ${idle} 0 0 0 0 0 0`,
    `cpu0 ${user} 0 ${system} ${idle} 0 0 0 0 0 0`,
    'intr 0',
    'ctxt 0',
    `btime ${Math.floor(listing.boot / 1000)}`,
    `processes ${listing.processes.length}`,
    'procs_running 1',
    'procs_blocked 0',
    '',
  ].join('\n');
}

export function memorySource(scope: object = globalThis): MemorySource {
  const nav = (scope as { navigator?: { deviceMemory?: unknown } }).navigator;
  const perf = (scope as { performance?: { memory?: { usedJSHeapSize?: unknown } } }).performance;
  const deviceMemory = nav?.deviceMemory;
  const used = perf?.memory?.usedJSHeapSize;
  return {
    ...(typeof deviceMemory === 'number' && deviceMemory > 0 ? { deviceMemory } : {}),
    ...(typeof used === 'number' ? { usedHeap: used } : {}),
  };
}

interface ProcNode {
  name: string;
  mode: number;
  id?: number;
  parent?: ProcNode;
  node_ops: {
    lookup?: (parent: ProcNode, name: string) => ProcNode;
    readdir?: (node: ProcNode) => string[];
    getattr?: (node: ProcNode) => object;
    setattr?: (node: ProcNode, attr: object) => void;
    readlink?: (node: ProcNode) => string;
  };
  stream_ops?: object;
}

interface ProcStream {
  node: ProcNode;
  position: number;
  sliccProc?: Uint8Array;
  getdents?: string[] | null;
  fd?: number | null;
}

interface DirStreamOps {
  open?: (stream: ProcStream) => void;
  dup?: (stream: ProcStream) => void;
  close?: (stream: ProcStream) => void;
}

export interface ProcFs {
  lookupPath?(path: string, opts?: { follow?: boolean }): { node: object };
  createNode?(parent: object, name: string, mode: number, rdev: number): object;
  hashRemoveNode?(node: object): void;
  streams?: unknown[];
  ErrnoError: new (errno: number) => Error;
}

function attr(node: ProcNode): object {
  const now = new Date();
  return {
    dev: 3,
    ino: node.id,
    mode: node.mode,
    nlink: 1,
    uid: UID,
    gid: UID,
    rdev: 0,
    size: 0,
    atime: now,
    mtime: now,
    ctime: now,
    blksize: 4096,
    blocks: 0,
  };
}

export function useProcfs(Fs: ProcFs, sys: ProcSys, pid: number, memory = memorySource()): void {
  const { lookupPath, createNode, hashRemoveNode } = Fs;
  const procList = sys.procList?.bind(sys);
  if (!lookupPath || !createNode || !hashRemoveNode || !procList) return;
  let proc: ProcNode;
  let self: ProcNode;
  try {
    proc = lookupPath.call(Fs, '/proc', { follow: true }).node as ProcNode;
    self = lookupPath.call(Fs, '/proc/self', { follow: true }).node as ProcNode;
  } catch {
    return;
  }
  const error = (errno = ENOENT) => new Fs.ErrnoError(errno);
  const fresh = (parent: ProcNode, name: string, mode: number): ProcNode => {
    const node = createNode.call(Fs, parent, name, mode, 0) as ProcNode;
    hashRemoveNode.call(Fs, node);
    node.node_ops = { getattr: attr, setattr: () => {} };
    node.stream_ops = {
      llseek: (stream: ProcStream, offset: number, whence: number) => {
        const at = (whence === 1 ? stream.position : 0) + offset;
        if (at < 0) throw error(EINVAL);
        return at;
      },
    };
    return node;
  };
  const file = (parent: ProcNode, name: string, content: () => string): ProcNode => {
    const node = fresh(parent, name, FILE_MODE);
    node.stream_ops = {
      open: (stream: ProcStream) => {
        stream.sliccProc = new TextEncoder().encode(content());
      },
      read: (
        stream: ProcStream,
        buffer: Uint8Array,
        offset: number,
        length: number,
        at: number
      ) => {
        const data = stream.sliccProc ?? new Uint8Array(0);
        const chunk = data.subarray(at, at + length);
        buffer.set(chunk, offset);
        return chunk.length;
      },
      llseek: (stream: ProcStream, offset: number, whence: number) => {
        const end = stream.sliccProc?.length ?? 0;
        const at = (whence === 1 ? stream.position : whence === 2 ? end : 0) + offset;
        if (at < 0) throw error(EINVAL);
        return at;
      },
    };
    return node;
  };
  const find = (processes: ProcessInfo[], target: number, own: boolean) =>
    (own ? processes.find((p) => p.tid === target) : undefined) ??
    processes.find((p) => p.pid === target || p.tid === target);
  const infoOf = (target: number): ProcessInfo | undefined =>
    find(procList().processes, target, false);
  const pidContent =
    (target: number, name: PidFile, own = false) =>
    () => {
      const listing = procList();
      const info = find(listing.processes, target, own);
      if (!info) throw error();
      return pidFile(name, info, listing.boot);
    };
  const sysDir = (parent: ProcNode, name: string, tree: ProcSysTree): ProcNode => {
    const dir = fresh(parent, name, DIR_MODE);
    dir.node_ops.lookup = (at, child) => {
      if (!Object.hasOwn(tree, child)) throw error();
      const next = tree[child] as ProcSysFile | ProcSysTree;
      return isSysFile(next)
        ? file(at, child, () => sysText(next, procList))
        : sysDir(at, child, next);
    };
    dir.node_ops.readdir = () => ['.', '..', ...Object.keys(tree)];
    return dir;
  };
  const pidNames = (names: string[]) => [...new Set([...names, ...PID_FILES])];
  const pidDir = (name: string, target: number): ProcNode => {
    const dir = fresh(proc, name, DIR_MODE);
    dir.node_ops.lookup = (parent, child) => {
      if (!(PID_FILES as readonly string[]).includes(child)) throw error();
      return file(parent, child, pidContent(target, child as PidFile));
    };
    dir.node_ops.readdir = () => ['.', '..', ...PID_FILES];
    return dir;
  };
  const scans = new Map<ProcStream, Set<number>>();
  const listed = (target: number) => {
    let found = false;
    for (const [stream, pids] of scans) {
      if (Fs.streams && Fs.streams[stream.fd ?? -1] !== stream) scans.delete(stream);
      else found ||= pids.has(target);
    }
    return found;
  };
  const procOps = proc.node_ops;
  const lookup = procOps.lookup?.bind(procOps);
  const readdir = procOps.readdir?.bind(procOps);
  const listAll = (node: ProcNode) => {
    const names = new Set(readdir ? readdir(node) : ['.', '..']);
    for (const name of [...SYSTEM_FILES, 'mounts', 'sys']) names.add(name);
    for (const p of procList().processes) names.add(String(p.pid));
    return [...names];
  };
  proc.node_ops = {
    ...procOps,
    lookup: (parent, name) => {
      if (/^[1-9]\d*$/.test(name)) {
        if (!infoOf(Number(name)) && !listed(Number(name))) throw error();
        return pidDir(name, Number(name));
      }
      if (name === 'mounts') return file(parent, name, () => mountTable(sys.mountList?.() ?? []));
      if (name === 'sys') return sysDir(parent, name, SYS_TREE);
      if ((SYSTEM_FILES as readonly string[]).includes(name)) {
        return file(parent, name, () =>
          systemFile(name as SystemFile, procList(), Date.now(), memory)
        );
      }
      if (!lookup) throw error();
      return lookup(parent, name);
    },
    readdir: (node) => listAll(node),
  };
  const track = (stream: ProcStream, names: string[] | null | undefined) => {
    let current = names;
    const remember = (list: string[]) =>
      scans.set(stream, new Set(list.filter((n) => /^[1-9]\d*$/.test(n)).map(Number)));
    remember(current ?? []);
    Object.defineProperty(stream, 'getdents', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (next: string[] | null) => {
        current = next;
        if (next) remember(next);
      },
    });
  };
  const dirOps = (proc.stream_ops ?? {}) as DirStreamOps;
  proc.stream_ops = {
    ...dirOps,
    open: (stream: ProcStream) => {
      dirOps.open?.(stream);
      track(stream, listAll(proc));
    },
    dup: (stream: ProcStream) => {
      dirOps.dup?.(stream);
      track(stream, stream.getdents);
    },
    close: (stream: ProcStream) => {
      scans.delete(stream);
      dirOps.close?.(stream);
    },
  };
  hashRemoveNode.call(Fs, self);
  const link = fresh(proc, 'self', LINK_MODE);
  const shownPid = () => String(find(procList().processes, pid, true)?.pid ?? pid);
  link.node_ops.readlink = shownPid;
  const procLookup = proc.node_ops.lookup as NonNullable<ProcNode['node_ops']['lookup']>;
  proc.node_ops.lookup = (parent, name) =>
    name === 'self' ? link : name === shownPid() ? self : procLookup(parent, name);
  const selfOps = self.node_ops;
  const selfLookup = selfOps.lookup?.bind(selfOps);
  const selfReaddir = selfOps.readdir?.bind(selfOps);
  self.node_ops = {
    ...selfOps,
    lookup: (parent, name) => {
      if ((PID_FILES as readonly string[]).includes(name)) {
        return file(parent, name, pidContent(pid, name as PidFile, true));
      }
      if (!selfLookup) throw error();
      return selfLookup(parent, name);
    },
    readdir: (node) => pidNames(selfReaddir ? selfReaddir(node) : ['.', '..']),
  };
}
