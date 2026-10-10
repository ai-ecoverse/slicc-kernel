import { ROOT } from '../kernel/cred.ts';
import type { MountLine, ProcessInfo, ProcessListing } from '../kernel/proc-info.ts';
import { mountTable } from './process-fds.ts';

const HZ = 100;
const DIR_MODE = 0o40555;
const FILE_MODE = 0o100444;
const LINK_MODE = 0o120777;
const ENOENT = 44;
const ESRCH = 71;
const EINVAL = 28;
const UID = 1000;
const KIB = 1024;
const FALLBACK_MEMORY = 4 * KIB * KIB * KIB;

export const PID_FILES = ['cmdline', 'comm', 'stat', 'statm', 'status'] as const;
export const SYSTEM_FILES = ['loadavg', 'meminfo', 'stat', 'uptime'] as const;

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

export function pidStat(info: ProcessInfo, boot: number): string {
  const fields = [
    info.pid,
    `(${commOf(info)})`,
    info.state,
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
    0,
    0,
    0,
    0,
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

export function pidStatus(info: ProcessInfo): string {
  const state = info.state === 'Z' ? 'Z (zombie)' : 'S (sleeping)';
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
    'SigBlk:\t0000000000000000',
    'SigIgn:\t0000000000000000',
    'SigCgt:\t0000000000000000',
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
    return `0.00 0.00 0.00 1/${live.length} ${last}\n`;
  }
  const idle = ticks(now - listing.boot);
  return [
    `cpu  0 0 0 ${idle} 0 0 0 0 0 0`,
    `cpu0 0 0 0 ${idle} 0 0 0 0 0 0`,
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
}

export interface ProcFs {
  lookupPath?(path: string, opts?: { follow?: boolean }): { node: object };
  createNode?(parent: object, name: string, mode: number, rdev: number): object;
  hashRemoveNode?(node: object): void;
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
      if (!info) throw error(ESRCH);
      return pidFile(name, info, listing.boot);
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
  const procOps = proc.node_ops;
  const lookup = procOps.lookup?.bind(procOps);
  const readdir = procOps.readdir?.bind(procOps);
  proc.node_ops = {
    ...procOps,
    lookup: (parent, name) => {
      if (/^[1-9]\d*$/.test(name)) {
        if (!infoOf(Number(name))) throw error();
        return pidDir(name, Number(name));
      }
      if (name === 'mounts') return file(parent, name, () => mountTable(sys.mountList?.() ?? []));
      if ((SYSTEM_FILES as readonly string[]).includes(name)) {
        return file(parent, name, () =>
          systemFile(name as SystemFile, procList(), Date.now(), memory)
        );
      }
      if (!lookup) throw error();
      return lookup(parent, name);
    },
    readdir: (node) => {
      const names = new Set(readdir ? readdir(node) : ['.', '..']);
      for (const name of [...SYSTEM_FILES, 'mounts']) names.add(name);
      for (const p of procList().processes) names.add(String(p.pid));
      return [...names];
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
