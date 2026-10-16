import {
  flushLiveVfs,
  invalidateLiveVfs,
  type LiveCred,
  type LiveMountFsApi,
  liveRoot,
  mountLiveVfsDirs,
  readingLinks,
  useLiveChown,
} from './live-vfs-fs.ts';
import type { SyncFsPosixBridge } from './sync-fs-wire.ts';

const MODULE_OWNED_DIRS = new Set(['dev', 'proc']);

const SYNTHETIC_DIRS = ['/usr', '/bin'];

export interface EmscriptenFsForHook extends LiveMountFsApi {
  chdir(path: string): void;
  chown?(path: string | object, uid: number, gid: number, dontFollow?: boolean): void;
}

export interface EmscriptenVfsHandle {
  mounted: string[];
  flush(): void;
  flushDirty(): void;
  invalidate(): void;
}

export interface EmscriptenVfsHookDeps {
  bridge: SyncFsPosixBridge;
  cwd: string;
  warn: (message: string) => void;
  cred?: LiveCred;
}

const KERNEL_DEV_DIRS = ['/dev/shm'];

function kernelDevDirs(bridge: SyncFsPosixBridge): string[] {
  return KERNEL_DEV_DIRS.filter((dir) => {
    try {
      return bridge.stat(dir).isDirectory;
    } catch {
      return false;
    }
  });
}

function topLevelDirs(
  bridge: SyncFsPosixBridge,
  warn: (message: string) => void
): string[] | undefined {
  let names: string[];
  try {
    names = bridge.readdir('/');
  } catch (err) {
    warn(`cannot list the VFS root, nothing mounted: ${String(err)}`);
    return undefined;
  }
  const candidates = names
    .filter((name) => name && !name.includes('/') && !MODULE_OWNED_DIRS.has(name))
    .map((name) => `/${name}`);
  for (const dir of SYNTHETIC_DIRS) if (!candidates.includes(dir)) candidates.push(dir);
  const dirs: string[] = [];
  for (const dir of candidates) {
    try {
      if (bridge.stat(dir).isDirectory) dirs.push(dir);
    } catch {}
  }
  return dirs;
}

interface MayDeleteFs {
  mayDelete?(dir: object, name: string, isdir: boolean): number;
  lookupNode?(parent: object, name: string): { parent?: object };
}

function linuxRmdir(Fs: EmscriptenFsForHook): void {
  const raw = Fs as unknown as MayDeleteFs;
  const { mayDelete, lookupNode } = raw;
  if (!mayDelete || !lookupNode) return;
  raw.mayDelete = (dir: object, name: string, isdir: boolean): number => {
    const code = mayDelete.call(raw, dir, name, isdir);
    if (code !== 10 || !isdir) return code;
    try {
      const node = lookupNode.call(raw, dir, name) as { parent?: object };
      if (node === node.parent) return 10;
    } catch {
      return code;
    }
    return 0;
  };
}

export function mountVfsIntoEmscripten(
  Fs: EmscriptenFsForHook,
  deps: EmscriptenVfsHookDeps
): EmscriptenVfsHandle {
  const { bridge, warn } = deps;
  const dirs = topLevelDirs(bridge, warn);
  const { plugin, mounted } = mountLiveVfsDirs(
    Fs,
    bridge,
    [...(dirs ?? []), ...kernelDevDirs(bridge)],
    warn
  );
  if (dirs) liveRoot(Fs, bridge);
  if (bridge.owners && Fs.lookupPath) useLiveChown(Fs as Parameters<typeof useLiveChown>[0]);
  if (bridge.links && Fs.lookupPath) readingLinks(Fs as Parameters<typeof readingLinks>[0]);
  linuxRmdir(Fs);
  if (deps.cred) Fs.sliccCred = deps.cred;
  try {
    Fs.chdir(deps.cwd);
  } catch (err) {
    warn(`cannot chdir to ${deps.cwd}: errno ${(err as { errno?: unknown }).errno}`);
  }
  return {
    mounted,
    flush: () => flushLiveVfs(Fs, plugin),
    flushDirty: () => plugin.flushDirty(),
    invalidate: () => invalidateLiveVfs(Fs, plugin),
  };
}
