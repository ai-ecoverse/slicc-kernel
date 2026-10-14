import type { MountLine, ProcessListing } from '../../kernel/proc-info.ts';
import type { SyncSabRequestBody } from '../../realm/sync-sab-wire.ts';
import { memorySource } from '../procfs.ts';
import { inProc, ProcTree } from '../wasi/wasi-procfs.ts';
import { type DevStep, devAsync, devSync } from './js-dev.ts';
import { JsCallError } from './js-kernel.ts';

export { inProc };

export function* procStep<T>(abs: string, pid: number, run: (tree: ProcTree) => T): DevStep<T> {
  const listing = (yield { op: 'proc-list' }) as ProcessListing;
  const mounts = abs === '/proc/mounts' ? ((yield { op: 'mount-list' }) as MountLine[]) : [];
  const tree = new ProcTree(
    { procList: () => listing, mountList: () => mounts },
    pid,
    memorySource()
  );
  try {
    return run(tree);
  } catch (err) {
    throw new JsCallError((err as { code?: string }).code ?? 'EIO', abs);
  }
}

export function readOnly(path: string): never {
  throw new JsCallError('EROFS', path);
}

export interface ProcOpenOptions {
  write?: boolean;
  append?: boolean;
  create?: boolean;
  truncate?: boolean;
  exclusive?: boolean;
}

export function procWrites(options: ProcOpenOptions | undefined): boolean {
  return !!(
    options?.write ||
    options?.append ||
    options?.create ||
    options?.truncate ||
    options?.exclusive
  );
}

function snapshotFile(path: string, bytes: Uint8Array) {
  return {
    fd: -1,
    path,
    size: () => bytes.length,
    read: (position: number, length: number) =>
      bytes.slice(Math.max(0, position), Math.max(0, position) + Math.max(0, length)),
    write: (): number => {
      throw new JsCallError('EBADF', path);
    },
    truncate: (): void => {
      throw new JsCallError('EBADF', path);
    },
    sync: () => undefined,
    close: () => undefined,
  };
}

function promised<T extends object>(file: T): T {
  const out: Record<string, unknown> = { ...(file as Record<string, unknown>) };
  for (const [name, value] of Object.entries(file)) {
    if (typeof value === 'function') {
      out[name] = (...args: unknown[]) => new Promise((resolve) => resolve(value(...args)));
    }
  }
  return out as T;
}

type ProcRun = <T>(step: DevStep<T>) => T | Promise<T>;

interface ProcPaths {
  resolve: (path: string) => string;
  pid: number;
}

const WRITES = ['mkdir', 'rm', 'unlink', 'chmod', 'writeFile'] as const;
const TWO = ['rename', 'link'] as const;

function procOps(paths: ProcPaths, run: ProcRun) {
  const at = (path: string) => {
    const abs = paths.resolve(path);
    return inProc(abs) ? abs : undefined;
  };
  const step = <T>(abs: string, op: (tree: ProcTree) => T) => run(procStep(abs, paths.pid, op));
  return { at, step };
}

export function withProc<F extends Record<string, unknown>>(
  fs: F,
  paths: ProcPaths,
  run: ProcRun
): F {
  const { at, step } = procOps(paths, run);
  const out: Record<string, unknown> = { ...fs };
  const pass = fs as Record<string, (...args: unknown[]) => unknown>;
  const reads: Record<string, (tree: ProcTree, abs: string) => unknown> = {
    stat: (tree, abs) => tree.stat(abs, true),
    lstat: (tree, abs) => tree.stat(abs, false),
    exists: (tree, abs) => tree.exists(abs),
    readdir: (tree, abs) => tree.readdir(abs),
    readlink: (tree, abs) => tree.readlink(abs),
    readFile: (tree, abs) => tree.read(abs),
  };
  for (const [name, read] of Object.entries(reads)) {
    out[name] = (path: string, ...rest: unknown[]) => {
      const abs = at(path);
      return abs ? step(abs, (tree) => read(tree, abs)) : pass[name]?.(path, ...rest);
    };
  }
  for (const name of WRITES) {
    out[name] = (path: string, ...rest: unknown[]) => {
      const abs = at(path);
      return abs ? run(refuse(abs)) : pass[name]?.(path, ...rest);
    };
  }
  for (const name of TWO) {
    out[name] = (from: string, to: string) => {
      const abs = at(from) ?? at(to);
      return abs ? run(refuse(abs)) : pass[name]?.(from, to);
    };
  }
  out.symlink = (target: string, path: string) => {
    const abs = at(path);
    return abs ? run(refuse(abs)) : pass.symlink?.(target, path);
  };
  return out as F;
}

function* refuse(abs: string): DevStep<never> {
  yield* [];
  return readOnly(abs);
}

export function procOpen<O, R>(
  open: (path: string, options?: O) => R,
  paths: ProcPaths,
  run: ProcRun,
  async = false
): (path: string, options?: O) => R {
  const { at, step } = procOps(paths, run);
  return (path, options) => {
    const abs = at(path);
    if (!abs) return open(path, options);
    if (procWrites(options as ProcOpenOptions | undefined)) return run(refuse(abs)) as R;
    return step(abs, (tree) => {
      const file = snapshotFile(abs, tree.read(abs));
      return async ? promised(file) : file;
    }) as R;
  };
}

type Lane = { json(req: SyncSabRequestBody): unknown };
type AsyncLane = { json(req: SyncSabRequestBody): Promise<unknown> };

export function procFsAsync<F extends object>(fs: F, kernel: AsyncLane, paths: ProcPaths): F {
  return withProc(fs as Record<string, unknown>, paths, (step) => devAsync(kernel, step)) as F;
}

export function procFsSync<F extends object>(fs: F, kernel: Lane, paths: ProcPaths): F {
  return withProc(fs as Record<string, unknown>, paths, (step) => devSync(kernel, step)) as F;
}

export function procOpenAsync<O, R>(
  open: (path: string, options?: O) => R,
  kernel: AsyncLane,
  paths: ProcPaths
) {
  return procOpen(open, paths, (step) => devAsync(kernel, step), true);
}

export function procOpenSync<O, R>(
  open: (path: string, options?: O) => R,
  kernel: Lane,
  paths: ProcPaths
) {
  return procOpen(open, paths, (step) => devSync(kernel, step));
}
