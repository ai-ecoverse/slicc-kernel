import type { DeviceNodeInfo } from '../../kernel/devices.ts';
import { inSys, SysTree } from '../../kernel/sysfs.ts';
import {
  type SyncFsBridgeStat,
  type SyncFsPosixBridge,
  syncError,
} from '../../realm/sync-fs-wire.ts';

const ONE = [
  'writeFile',
  'mkdir',
  'rm',
  'unlink',
  'rmdir',
  'chmod',
  'utimes',
  'lutimes',
  'create',
  'mkfifo',
  'chown',
  'pwrite',
  'truncate',
  'append',
] as const;
const TWO = ['rename', 'link', 'copy'] as const;

function refuse(p: string): never {
  throw syncError('EROFS', p);
}

function listed(tree: SysTree, p: string): Array<[string, SyncFsBridgeStat | null]> {
  const out: Array<[string, SyncFsBridgeStat | null]> = [];
  for (const name of tree.readdir(p)) out.push([name, tree.stat(`${p}/${name}`, false)]);
  return out;
}

export function sysfsBridge<T extends SyncFsPosixBridge>(
  fs: T,
  nodes: () => readonly DeviceNodeInfo[]
): T {
  const tree = (): SysTree => new SysTree(nodes);
  const over: Partial<SyncFsPosixBridge> = {
    readFile: (p: string) => (inSys(p) ? tree().read(p) : fs.readFile(p)),
    stat: (p: string) => (inSys(p) ? tree().stat(p) : fs.stat(p)),
    lstat: (p: string) => (inSys(p) ? tree().stat(p, false) : fs.lstat(p)),
    readlink: (p: string) => (inSys(p) ? tree().readlink(p) : fs.readlink(p)),
    exists: (p: string) => (inSys(p) ? tree().exists(p) : fs.exists(p)),
    readdir: (p: string) => {
      if (inSys(p)) return tree().readdir(p);
      const names = fs.readdir(p);
      return p !== '/' || names.includes('sys') ? names : [...names, 'sys'];
    },
    readdirStat: (p: string) => {
      if (inSys(p)) return listed(tree(), p);
      const entries = fs.readdirStat(p);
      if (p !== '/' || entries.some(([name]) => name === 'sys')) return entries;
      return [...entries, ['sys', new SysTree(() => []).stat('/sys')]];
    },
    symlink: (target: string, link: string) =>
      inSys(link) ? refuse(link) : fs.symlink(target, link),
  };
  const { access, hold, pread } = fs;
  if (access)
    over.access = (p, mode, ...rest) =>
      inSys(p) ? tree().access(p, mode) : access.call(fs, p, mode, ...rest);
  if (hold) over.hold = (p, ...rest) => (inSys(p) ? undefined : hold.call(fs, p, ...rest));
  if (pread)
    over.pread = (p, at, n, version) =>
      inSys(p)
        ? tree()
            .read(p)
            .subarray(at, at + n)
        : pread.call(fs, p, at, n, version);
  for (const name of ONE) {
    const fn = fs[name] as ((p: string, ...rest: unknown[]) => unknown) | undefined;
    if (!fn) continue;
    (over as Record<string, unknown>)[name] = ((p: string, ...rest: unknown[]) =>
      inSys(p) ? refuse(p) : fn.call(fs, p, ...rest)) as SyncFsPosixBridge[typeof name];
  }
  for (const name of TWO) {
    const fn = fs[name] as ((from: string, to: string, ...rest: unknown[]) => unknown) | undefined;
    if (!fn) continue;
    (over as Record<string, unknown>)[name] = ((from: string, to: string, ...rest: unknown[]) =>
      inSys(to) || (name !== 'copy' && inSys(from))
        ? refuse(inSys(to) ? to : from)
        : fn.call(fs, from, to, ...rest)) as SyncFsPosixBridge[typeof name];
  }
  return new Proxy(fs, {
    get: (target, key, receiver) =>
      key in over ? over[key as keyof SyncFsPosixBridge] : Reflect.get(target, key, receiver),
  });
}
