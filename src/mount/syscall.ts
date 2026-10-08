import { normalizePath } from '../fs/types.ts';
import { errnoError } from './connection.ts';
import { type MountSpec, parseSize } from './mount-fs.ts';

export const MS_RDONLY = 1;
const MS_MGC_MSK = 0xffff0000;
const MS_MGC_VAL = 0xc0ed0000;

const IGNORED_FLAGS =
  2 | 4 | 8 | 16 | 128 | 1024 | 2048 | 32768 | (1 << 21) | (1 << 24) | (1 << 25);

export const MNT_FORCE = 1;
export const MNT_DETACH = 2;
const UMOUNT_NOFOLLOW = 8;

const GENERIC = new Set([
  'defaults',
  'async',
  'sync',
  'dirsync',
  'atime',
  'noatime',
  'diratime',
  'nodiratime',
  'relatime',
  'norelatime',
  'strictatime',
  'nostrictatime',
  'lazytime',
  'nolazytime',
  'suid',
  'nosuid',
  'dev',
  'nodev',
  'exec',
  'noexec',
  'auto',
  'noauto',
  'user',
  'nouser',
  'users',
  'nofail',
  '_netdev',
  'silent',
  'loud',
]);

export interface MountCall {
  source: string;
  target: string;
  type: string;
  flags: number;
  data: string;
}

export interface ProcessMountRequest {
  op: 'mount' | 'umount';
  pid: number;
  target: string;
  type?: string;
  source?: string;
  options?: Record<string, string>;
}

export type ProcessMountPolicy =
  | boolean
  | ((req: ProcessMountRequest) => boolean | Promise<boolean>);

export function parseMountOptions(data: string): Record<string, string> {
  const options: Record<string, string> = {};
  for (const raw of data.split(',')) {
    const item = raw.trim();
    if (!item || GENERIC.has(item)) continue;
    if (item === 'rw') {
      delete options.ro;
      continue;
    }
    const eq = item.indexOf('=');
    if (eq === 0) throw errnoError('EINVAL', `bad mount option ${item}`);
    if (eq < 0) options[item] = '';
    else options[item.slice(0, eq)] = item.slice(eq + 1);
  }
  if (options.maxfile !== undefined) parseSize(options.maxfile);
  return options;
}

export function refusedTarget(target: string): void {
  const at = normalizePath(target);
  const kernel = at === '/' || [`/proc`, `/dev`].some((k) => at === k || at.startsWith(`${k}/`));
  if (kernel) throw errnoError('EBUSY', `${at} belongs to the kernel`);
}

function absolute(target: string): string {
  if (!target) throw errnoError('ENOENT', 'no mount point');
  if (!target.startsWith('/')) throw errnoError('EINVAL', `not an absolute path: ${target}`);
  return normalizePath(target);
}

export function mountCall(call: MountCall): MountSpec {
  let flags = call.flags >>> 0;
  if ((flags & MS_MGC_MSK) >>> 0 === MS_MGC_VAL) flags &= ~MS_MGC_MSK;
  if (flags & ~(MS_RDONLY | IGNORED_FLAGS)) {
    throw errnoError('EINVAL', `unsupported mount flags ${flags.toString(16)}`);
  }
  if (!call.type) throw errnoError('EINVAL', 'no file system type');
  const target = absolute(call.target);
  refusedTarget(target);
  const options = parseMountOptions(call.data);
  if (flags & MS_RDONLY) options.ro = '';
  return { type: call.type, source: call.source || 'none', target, options };
}

export function umountCall(target: string, flags: number): { target: string; detach: boolean } {
  const known = MNT_FORCE | MNT_DETACH | UMOUNT_NOFOLLOW;
  if ((flags >>> 0) & ~known) throw errnoError('EINVAL', `unsupported umount flags ${flags}`);
  const at = absolute(target);
  refusedTarget(at);
  return { target: at, detach: (flags & (MNT_FORCE | MNT_DETACH)) !== 0 };
}
