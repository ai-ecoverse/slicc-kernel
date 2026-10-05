import {
  flushLiveVfs,
  invalidateLiveVfs,
  type LiveMountFsApi,
  liveRoot,
  mountLiveVfsDirs,
} from './live-vfs-fs.ts';
import type { SyncFsPosixBridge } from './sync-fs-wire.ts';

const MODULE_OWNED_DIRS = new Set(['dev', 'proc']);

const SYNTHETIC_DIRS = ['/usr', '/bin'];

export interface EmscriptenFsForHook extends LiveMountFsApi {
  chdir(path: string): void;
}

export interface EmscriptenVfsHandle {
  mounted: string[];
  flush(): void;
  invalidate(): void;
}

export interface EmscriptenVfsHookDeps {
  bridge: SyncFsPosixBridge;
  cwd: string;
  warn: (message: string) => void;
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

export function mountVfsIntoEmscripten(
  Fs: EmscriptenFsForHook,
  deps: EmscriptenVfsHookDeps
): EmscriptenVfsHandle {
  const { bridge, warn } = deps;
  const dirs = topLevelDirs(bridge, warn);
  const { plugin, mounted } = mountLiveVfsDirs(Fs, bridge, dirs ?? [], warn);
  if (dirs) liveRoot(Fs, bridge);
  try {
    Fs.chdir(deps.cwd);
  } catch (err) {
    warn(`cannot chdir to ${deps.cwd}: ${String(err)}`);
  }
  return {
    mounted,
    flush: () => flushLiveVfs(Fs, plugin),
    invalidate: () => invalidateLiveVfs(Fs, plugin),
  };
}
