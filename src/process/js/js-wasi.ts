import type { SyncFsResult } from '../../realm/sync-fs-wire.ts';
import { createSyncFsSabBridge, type SyncSabTransport } from '../../realm/sync-sab-bridge.ts';
import type { SyncSabRequestBody } from '../../realm/sync-sab-wire.ts';
import { kernelSys } from '../process-runtime.ts';
import { E, EVENTTYPE } from '../wasi/wasi-abi.ts';
import { normalize } from '../wasi/wasi-files.ts';
import { type WasiFunction, WasiHost } from '../wasi/wasi-host.ts';
import { JsCallError } from './js-kernel.ts';
import type { SyncCall } from './js-sync.ts';

export interface JsWasiOptions {
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  preopens?: Readonly<Record<string, string>>;
  stdio?: readonly [number, number, number];
  returnOnExit?: boolean;
}

export interface JsWasi {
  readonly imports: { wasi_snapshot_preview1: Record<string, WasiFunction> };
  readonly wasiImport: Record<string, WasiFunction>;
  bind(memory: WebAssembly.Memory): void;
  start(instance: WebAssembly.Instance): number;
  initialize(instance: WebAssembly.Instance): void;
  close(): void;
}

export class JsWasiExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`wasi exit ${code}`);
    this.code = code;
  }
}

export interface JsWasiDeps {
  lane: SyncCall;
  pid: number;
  cwd: string;
  resolve(path: string): string;
  fs: { owners: boolean; links: boolean } | undefined;
  live: Set<JsWasi>;
  owned: OwnedFds;
}

export interface OwnedFds {
  add(fd: number): void;
  remove(fd: number): void;
}

export function ownedFds(sab: SharedArrayBuffer | undefined): OwnedFds {
  if (!sab) return { add: () => {}, remove: () => {} };
  const view = new Int32Array(sab);
  const fds = new Set<number>();
  const publish = (): void => {
    Atomics.store(view, 0, 0);
    let n = 0;
    for (const fd of fds) {
      if (1 + n >= view.length) break;
      view[1 + n++] = fd;
    }
    Atomics.store(view, 0, n);
  };
  return {
    add(fd) {
      fds.add(fd);
      publish();
    },
    remove(fd) {
      if (fds.delete(fd)) publish();
    },
  };
}

const SUB_SIZE = 48;
const SUB_TAG = 8;
const SUB_FD = 16;
const NO_FD = 0x7fffffff;

type PathArgs = readonly [fd: number, ptr: number, len: number];

const PATHS: Readonly<Record<string, readonly PathArgs[]>> = {
  path_open: [[0, 2, 3]],
  path_filestat_get: [[0, 2, 3]],
  path_filestat_set_times: [[0, 2, 3]],
  path_create_directory: [[0, 1, 2]],
  path_remove_directory: [[0, 1, 2]],
  path_unlink_file: [[0, 1, 2]],
  path_readlink: [[0, 1, 2]],
  path_symlink: [[2, 3, 4]],
  path_rename: [
    [0, 1, 2],
    [3, 4, 5],
  ],
  path_link: [
    [0, 2, 3],
    [4, 5, 6],
  ],
};

const RESULTS: Readonly<Record<string, number>> = { path_open: 8, sock_accept: 2 };

const SPECIAL = new Set(['fd_close', 'fd_renumber', 'poll_oneoff', 'proc_exit']);

function fdArgsOf(name: string): readonly number[] {
  const paths = PATHS[name];
  if (paths) return paths.map(([fd]) => fd);
  return /^(fd|sock)_/.test(name) ? [0] : [];
}

function laneTransport(lane: SyncCall): SyncSabTransport {
  return { call: (req: SyncSabRequestBody): SyncFsResult => lane(req) };
}

function within(root: string, dir: string, path: string): boolean {
  if (path.startsWith('/')) return false;
  const base = dir === root ? [] : dir.slice(root === '/' ? 1 : root.length + 1).split('/');
  const parts = [...base];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return false;
      parts.pop();
    } else parts.push(seg);
  }
  return true;
}

function preopensOf(
  given: Readonly<Record<string, string>> | undefined,
  resolve: (path: string) => string
): Array<[string, string]> {
  if (given === undefined) return [];
  if (typeof given !== 'object' || given === null) throw new JsCallError('EINVAL', 'wasi preopens');
  return Object.entries(given).map(([name, path]) => {
    if (typeof path !== 'string' || path === '') throw new JsCallError('EINVAL', 'wasi preopens');
    return [name, normalize(resolve(path))];
  });
}

export function createJsWasi(deps: JsWasiDeps, o: JsWasiOptions = {}): JsWasi {
  const transport = laneTransport(deps.lane);
  const sys = kernelSys(transport);
  const call = (req: SyncSabRequestBody): unknown => {
    const r = deps.lane(req);
    if (!r.ok) throw new JsCallError(r.errno, req.op);
    return r.kind === 'json' ? r.json : r.kind === 'bytes' ? r.bytes : undefined;
  };
  const host = new WasiHost({
    args: [...(o.args ?? [])],
    env: { ...(o.env ?? {}) },
    cwd: deps.cwd,
    pid: deps.pid,
    kernel: { sys, call: call as WasiHost['o']['kernel']['call'] },
    fs: createSyncFsSabBridge(transport, { ...deps.fs, direct: true }),
    bare: true,
  });
  const owned = deps.owned;
  const guest = new Map<number, number>();
  const own = (g: number, k: number): void => {
    guest.set(g, k);
    owned.add(k);
  };
  const roots = new Map<number, string>();
  const opened: number[] = [];
  const closeKernel = (fd: number): void => {
    owned.remove(fd);
    try {
      host.fds.close(fd);
    } catch {}
  };
  try {
    (o.stdio ?? [0, 1, 2]).forEach((fd, i) => {
      const k = host.fds.adoptCopy(fd);
      opened.push(k);
      own(i, k);
    });
    for (const [name, path] of preopensOf(o.preopens, deps.resolve)) {
      const k = host.fds.preopenAt(path, name);
      opened.push(k);
      const g = 3 + roots.size;
      own(g, k);
      roots.set(g, path);
    }
  } catch (err) {
    for (const k of opened) closeKernel(k);
    throw err;
  }
  const table = host.imports();
  const view = () => host.mem.view();
  const free = (): number => {
    let g = 3;
    while (guest.has(g)) g++;
    return g;
  };
  const confined = (name: string, args: number[]): boolean => {
    for (const [fdAt, ptrAt, lenAt] of PATHS[name] ?? []) {
      const g = args[fdAt];
      const root = roots.get(g);
      const dir = host.fds.find(guest.get(g) as number);
      if (root === undefined || dir?.type !== 'dir') continue;
      if (!within(root, dir.path, host.mem.string(args[ptrAt], args[lenAt]))) return false;
    }
    return true;
  };
  const opens = (out: number, root: string | undefined): void => {
    const k = view().getUint32(out, true);
    const g = free();
    own(g, k);
    if (root !== undefined) roots.set(g, root);
    view().setUint32(out, g, true);
  };
  const imports: Record<string, WasiFunction> = {};
  for (const [name, fn] of Object.entries(table)) {
    if (SPECIAL.has(name)) continue;
    const fdArgs = fdArgsOf(name);
    imports[name] = ((...raw: number[]) => {
      const args = [...raw];
      for (const at of fdArgs) {
        const k = guest.get(args[at]);
        if (k === undefined) return E.BADF;
        args[at] = k;
      }
      if (!confined(name, raw)) return E.NOTCAPABLE;
      const out = RESULTS[name];
      if (out !== undefined && (raw[out] >>> 0) + 4 > host.mem.size()) return E.FAULT;
      const errno = (fn as (...a: number[]) => number)(...args);
      if (errno !== E.SUCCESS) return errno;
      if (out !== undefined) opens(raw[out] >>> 0, roots.get(raw[0]));
      return errno;
    }) as WasiFunction;
  }
  imports.fd_close = ((g: number) => {
    const k = guest.get(g);
    if (k === undefined) return E.BADF;
    guest.delete(g);
    roots.delete(g);
    owned.remove(k);
    return (table.fd_close as (fd: number) => number)(k);
  }) as WasiFunction;
  imports.fd_renumber = ((from: number, to: number) => {
    const kf = guest.get(from);
    const kt = guest.get(to);
    if (kf === undefined || kt === undefined) return E.BADF;
    if (from === to) return E.SUCCESS;
    closeKernel(kt);
    guest.set(to, kf);
    const root = roots.get(from);
    if (root === undefined) roots.delete(to);
    else roots.set(to, root);
    guest.delete(from);
    roots.delete(from);
    return E.SUCCESS;
  }) as WasiFunction;
  imports.poll_oneoff = ((inPtr: number, outPtr: number, n: number, nevents: number) => {
    const v = view();
    const swapped: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const at = inPtr + i * SUB_SIZE;
      const tag = v.getUint8(at + SUB_TAG);
      if (tag !== EVENTTYPE.FD_READ && tag !== EVENTTYPE.FD_WRITE) continue;
      const g = v.getUint32(at + SUB_FD, true);
      swapped.push([at + SUB_FD, g]);
      v.setUint32(at + SUB_FD, guest.get(g) ?? NO_FD, true);
    }
    try {
      return (table.poll_oneoff as (...a: number[]) => number)(inPtr, outPtr, n, nevents);
    } finally {
      const after = view();
      for (const [at, g] of swapped) after.setUint32(at, g, true);
    }
  }) as WasiFunction;
  imports.proc_exit = ((code: number) => {
    throw new JsWasiExit(code);
  }) as WasiFunction;

  let closed = false;
  const run = (instance: WebAssembly.Instance, entry: '_start' | '_initialize'): number => {
    const memory = instance.exports.memory;
    if (memory instanceof WebAssembly.Memory) host.mem.bind(memory);
    const fn = instance.exports[entry];
    if (typeof fn !== 'function') {
      if (entry === '_initialize') return 0;
      throw new JsCallError('EINVAL', `wasi: the instance exports no ${entry}`);
    }
    try {
      fn();
      return 0;
    } catch (err) {
      if (err instanceof JsWasiExit && o.returnOnExit !== false) return err.code;
      throw err;
    }
  };
  const wasi: JsWasi = {
    imports: { wasi_snapshot_preview1: imports },
    wasiImport: imports,
    bind: (memory) => {
      if (!(memory instanceof WebAssembly.Memory)) throw new JsCallError('EINVAL', 'wasi bind');
      host.mem.bind(memory);
    },
    start: (instance) => run(instance, '_start'),
    initialize: (instance) => void run(instance, '_initialize'),
    close: () => {
      if (closed) return;
      closed = true;
      deps.live.delete(wasi);
      for (const k of guest.values()) closeKernel(k);
      guest.clear();
      roots.clear();
    },
  };
  deps.live.add(wasi);
  return wasi;
}

export function wasiFor(
  o: Omit<JsWasiDeps, 'live' | 'owned'> & { owned: SharedArrayBuffer | undefined }
): { create(options?: JsWasiOptions): JsWasi; closeAll(): void } {
  const deps: JsWasiDeps = { ...o, live: new Set(), owned: ownedFds(o.owned) };
  return {
    create: (options) => createJsWasi(deps, options),
    closeAll: () => {
      for (const wasi of [...deps.live]) wasi.close();
    },
  };
}
