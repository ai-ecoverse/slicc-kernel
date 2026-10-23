import type { InheritedSlot } from '../kernel/children.ts';
import type { DeviceAccess, DeviceMeta, KernelDevice } from '../kernel/fd-table.ts';
import type { ForkStream, KernelStreamEntry } from '../kernel/protocol.ts';
import type { KernelStreams, ProcessFs, ProcessStream, ProcessSys } from './kernel-streams.ts';
import { closesOnExec, O_CLOEXEC, setCloseOnExec } from './process-fds.ts';

const O_RDWR = 0o2;
const O_ACCMODE = 0o3;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_TRUNC = 0o1000;

const PLACEHOLDER_DIR = '/dev/slicc-fd';

interface LiveNodeBag {
  live?: {
    orphan?: boolean;
    data?: Uint8Array;
    len?: number;
    handle?: number;
    stat?: { ino?: number };
    ranged?: {
      pinnedVersion?: string;
      size(): number;
      read(at: number, length: number): Uint8Array;
    };
  };
  mode: number;
}

function isVfsFile(Fs: ProcessFs, stream: ProcessStream): boolean {
  const node = stream.node as LiveNodeBag;
  return node.live !== undefined && Fs.isFile(node.mode);
}

function orphanContents(stream: ProcessStream): Uint8Array | undefined {
  const live = (stream.node as LiveNodeBag).live;
  if (!live?.orphan) return undefined;
  if (live.ranged) return live.ranged.read(0, live.ranged.size());
  return live.data?.slice(0, live.len ?? live.data.length) ?? new Uint8Array(0);
}

function heldOf(live: LiveNodeBag['live']): {
  pin?: { version: string; size: number };
  handle?: number;
  ino?: number;
} {
  const ranged = live?.ranged;
  const version = ranged?.pinnedVersion;
  const pin = ranged && version !== undefined ? { version, size: ranged.size() } : undefined;
  const handle = live?.handle;
  const ino = live?.stat?.ino;
  return {
    ...(pin ? { pin } : {}),
    ...(handle !== undefined ? { handle } : {}),
    ...(handle !== undefined && ino !== undefined ? { ino } : {}),
  };
}

export function vfsPromoter(
  Fs: ProcessFs,
  sys: ProcessSys,
  streams: KernelStreams,
  livePath: (stream: ProcessStream) => string
): (stream: ProcessStream) => void {
  const promoted = new Map<object, number>();
  return (stream) => {
    if (stream.sliccKernelFd !== undefined || !isVfsFile(Fs, stream)) return;
    const live = stream.stream_ops;
    let kfd = promoted.get(stream.shared);
    if (kfd === undefined) {
      live.fsync?.(stream);
      const contents = orphanContents(stream);
      const held = heldOf((stream.node as LiveNodeBag).live);
      kfd = sys.openVfs(
        livePath(stream),
        stream.flags,
        stream.position,
        contents !== undefined
          ? { contents, orphan: true }
          : Object.keys(held).length > 0
            ? held
            : undefined
      );
      promoted.set(stream.shared, kfd);
    }
    streams.attachFile(stream, kfd);
    streams.fstatFromKernel(stream, kfd);
  };
}

export function describeForFork(
  Fs: ProcessFs,
  sys: ProcessSys,
  streams: KernelStreams,
  livePath: (stream: ProcessStream) => string
): ForkStream[] {
  const promote = vfsPromoter(Fs, sys, streams, livePath);
  const out: ForkStream[] = [];
  for (const stream of Fs.streams) {
    if (!stream) continue;
    promote(stream);
    if (stream.sliccKernelFd !== undefined) {
      out.push(kernelEntry(stream, stream.sliccKernelFd));
    } else if (stream.path) {
      const flags = stream.flags | (closesOnExec(stream) ? O_CLOEXEC : 0);
      out.push({ fd: stream.fd, path: stream.path, flags });
    }
  }
  return out;
}

const NAMED_DEVICES: Readonly<Record<string, 'sealed' | 'clipboard' | 'embedder'>> = {
  '/dev/sealed': 'sealed',
  '/dev/clipboard': 'clipboard',
  '/dev/embedder': 'embedder',
};

const DEVICE_KINDS: ReadonlySet<string> = new Set(['sealed', 'clipboard', 'embedder']);

function kernelEntry(stream: ProcessStream, kernel: number): ForkStream {
  const cloexec = closesOnExec(stream) ? { cloexec: true } : {};
  if (stream.sliccKernelSocket) {
    return { fd: stream.fd, kernel, kind: 'socket', flags: stream.flags, ...cloexec };
  }
  const device = stream.path === undefined ? undefined : NAMED_DEVICES[stream.path];
  const kind = stream.sliccKernelFile ? 'file' : stream.tty ? 'tty' : (device ?? 'stream');
  const access = kind === 'tty' ? O_RDWR : (stream.flags ?? O_RDWR) & O_ACCMODE;
  const fifo = stream.sliccKernelFifo ? { fifo: stream.sliccKernelFifo } : {};
  return { fd: stream.fd, kernel, kind, flags: access, ...cloexec, ...fifo };
}

const ACCESS: Readonly<Record<number, DeviceAccess>> = { 0: 'read', 1: 'write' };

const DEVICES: Readonly<Record<string, KernelDevice>> = {
  '/dev/null': 'null',
  '/dev/zero': 'zero',
  '/dev/full': 'full',
  '/dev/urandom': 'urandom',
  '/dev/random': 'urandom',
};

export function describeInherited(
  Fs: ProcessFs,
  sys: ProcessSys,
  streams: KernelStreams,
  livePath: (stream: ProcessStream) => string,
  actions: ReadonlyArray<readonly [number, number]> = []
): InheritedSlot[] {
  const table = new Map<number, { stream: ProcessStream; cloexec: boolean }>();
  for (const stream of Fs.streams) {
    if (stream) table.set(stream.fd, { stream, cloexec: closesOnExec(stream) });
  }
  for (const [target, source] of actions) {
    if (target <= 2) continue;
    const from = source >= 0 ? table.get(source) : undefined;
    if (from) table.set(target, { stream: from.stream, cloexec: false });
    else table.delete(target);
  }
  const slots = new Map<number, ProcessStream>();
  for (const [fd, { stream, cloexec }] of table) {
    if (fd > 2 && !cloexec) slots.set(fd, stream);
  }
  const promote = vfsPromoter(Fs, sys, streams, livePath);
  const out: InheritedSlot[] = [];
  for (const [fd, stream] of slots) {
    promote(stream);
    const slot = inheritedSlot(fd, stream);
    if (slot) out.push(slot);
  }
  return out;
}

export function deviceOfStream(stream: ProcessStream): DeviceMeta | undefined {
  const device = stream.path === undefined ? undefined : DEVICES[stream.path];
  if (!device || stream.sliccKernelFd !== undefined) return undefined;
  const access = ACCESS[stream.flags & O_ACCMODE];
  return { device, ...(access ? { access } : {}) };
}

function inheritedSlot(fd: number, stream: ProcessStream): InheritedSlot | undefined {
  if (stream.sliccKernelFd === undefined) {
    const device = deviceOfStream(stream);
    return device ? { fd, ...device } : undefined;
  }
  const flags = stream.sliccKernelSocket ? { flags: stream.flags } : {};
  return { fd, kernel: stream.sliccKernelFd, ...flags };
}

function place(Fs: ProcessFs, stream: ProcessStream, fd: number): ProcessStream {
  if (stream.fd === fd) return stream;
  const moved = Fs.dupStream(stream, fd);
  Fs.closeStream(stream.fd);
  return moved;
}

function placeholder(
  Fs: ProcessFs,
  streams: KernelStreams,
  entry: { fd: number; kind: string; flags?: number }
): ProcessStream {
  const access = entry.flags ?? O_RDWR;
  if (entry.kind === 'socket') return streams.socketStream(access);
  if (entry.kind === 'tty') return Fs.open('/dev/tty', O_RDWR);
  if (entry.kind === 'stream' || DEVICE_KINDS.has(entry.kind)) return Fs.open('/dev/null', access);
  Fs.mkdirTree(PLACEHOLDER_DIR);
  return Fs.open(`${PLACEHOLDER_DIR}/${entry.fd}`, access | O_CREAT);
}

const FIFO_MODE = 0o010600;

let nextStreamIno = 0x40000000;

const streamInos = new WeakMap<KernelStreams, Map<string, number>>();

function asFifo(stream: ProcessStream, streams: KernelStreams, identity: string): void {
  const inos = streamInos.get(streams) ?? new Map<string, number>();
  streamInos.set(streams, inos);
  const fixed = inos.get(identity) ?? nextStreamIno++;
  inos.set(identity, fixed);
  const node = stream.node;
  streams.describe(stream, `pipe:[${fixed}]`, () => ({
    ...node.node_ops?.getattr?.(node),
    mode: FIFO_MODE,
    ino: fixed,
    size: 0,
  }));
}

export function placeKernelStream(
  Fs: ProcessFs,
  streams: KernelStreams,
  entry: KernelStreamEntry
): ProcessStream {
  const stream = place(Fs, placeholder(Fs, streams, entry), entry.fd);
  if (entry.kind === 'file') {
    streams.attachFile(stream, entry.kernel);
    streams.sizeFromKernel(stream, entry.kernel);
  } else if (entry.kind === 'socket') streams.attachSocket(stream, entry.kernel);
  else streams.attach(stream, entry.kernel, entry.kind === 'tty');
  if (entry.kind === 'clipboard' || entry.kind === 'embedder') streams.reportClose(entry.kernel);
  if (DEVICE_KINDS.has(entry.kind))
    streams.nameDevice(stream, entry.kind as 'sealed' | 'clipboard' | 'embedder');
  if (entry.kind === 'tty') streams.nameTerminal(stream);
  if (entry.kind === 'stream') {
    asFifo(stream, streams, entry.desc !== undefined ? `d${entry.desc}` : `k${entry.kernel}`);
    if (entry.fifo) stream.path = entry.fifo;
  }
  setCloseOnExec(stream, entry.cloexec === true);
  return stream;
}

export function restoreForkedStreams(
  Fs: ProcessFs,
  streams: KernelStreams,
  table: readonly ForkStream[]
): void {
  for (const stream of Fs.streams) if (stream) Fs.closeStream(stream.fd);
  for (const entry of table) {
    try {
      if ('kernel' in entry) {
        placeKernelStream(Fs, streams, entry);
      } else {
        const placed = place(
          Fs,
          Fs.open(entry.path, entry.flags & ~(O_CREAT | O_EXCL | O_TRUNC)),
          entry.fd
        );

        setCloseOnExec(placed, (entry.flags & O_CLOEXEC) !== 0);
      }
    } catch {}
  }
}
