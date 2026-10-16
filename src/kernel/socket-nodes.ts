import { W_OK } from '../fs/access.ts';
import { type Guard, inParent, need } from '../fs/dac.ts';
import { type FsStat, type KernelFs, type NewOwner, normalizePath } from '../fs/types.ts';
import { KernelError } from './fd-table.ts';
import type { SockAddr, SocketName } from './socket.ts';

export interface BoundName extends SocketName {
  remove(): Promise<void>;
}

export interface SocketNames {
  make(path: string): Promise<BoundName>;
  find(path: string): Promise<SocketName>;
}

export type SocketNameFs = Pick<KernelFs, 'stat' | 'lstat' | 'chmod' | 'rm'>;

export interface SocketNameDeps {
  fs: SocketNameFs;
  guard(): Guard | undefined;
  create(path: string, owner: NewOwner): Promise<void>;
  owner(): NewOwner;
  owners: boolean;
}

export function filePath(addr: SockAddr): string | undefined {
  if (addr.family !== 'unix' || addr.path === '' || addr.path.startsWith('\0')) return undefined;
  return normalizePath(addr.path);
}

function nameOf(st: FsStat): SocketName {
  return { key: `${st.dev ?? 0}:${st.ino}`, typed: st.isSocket === true };
}

function codeOf(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

export function socketNames(deps: SocketNameDeps): SocketNames {
  const { fs } = deps;
  return {
    async make(path) {
      const g = deps.guard();
      if (g) await inParent(g, 'bind', path);
      const owner = deps.owner();
      try {
        await deps.create(path, owner);
      } catch (err) {
        if (codeOf(err) === 'EEXIST') throw new KernelError('EADDRINUSE');
        throw err;
      }
      const remove = () => fs.rm(path, { file: true }).catch(() => undefined);
      try {
        if (!deps.owners && owner.mode !== undefined) await fs.chmod(path, owner.mode);
        return { ...nameOf(await fs.lstat(path)), remove };
      } catch (err) {
        await remove();
        throw err;
      }
    },
    async find(path) {
      const g = deps.guard();
      if (g) await need(g, 'connect', path, W_OK, { directory: false });
      return nameOf(await fs.stat(path));
    },
  };
}
