import { type KernelFs, normalizePath, rangedOps } from './types.ts';

const MAGIC = [0x00, 0x61, 0x73, 0x6d];
const MAX_FRESH = 1024;

interface Fresh {
  umask: number;
  pid: number;
  added: number;
}

function isModule(bytes: Uint8Array): boolean {
  return MAGIC.every((b, i) => bytes[i] === b);
}

export class FreshModules {
  private readonly fresh = new Map<string, Fresh>();

  add(path: string, umask: number, pid: number): void {
    if (this.fresh.size >= MAX_FRESH) this.fresh.clear();
    this.fresh.set(normalizePath(path), { umask: umask & 0o777, pid, added: 0 });
  }

  forget(pid: number): void {
    for (const [path, fresh] of this.fresh) if (fresh.pid === pid) this.fresh.delete(path);
  }

  wrap(fs: KernelFs): KernelFs {
    const decide = async (given: string, bytes: Uint8Array | string) => {
      const path = normalizePath(given);
      const fresh = this.fresh.get(path);
      if (!fresh || typeof bytes === 'string' || bytes.length < MAGIC.length) return;
      const want = isModule(bytes) ? 0o111 & ~fresh.umask : 0;
      if (want === fresh.added) return;
      const mode = (await fs.stat(path)).mode & 0o7777;
      await fs.chmod(path, (mode & ~fresh.added) | want);
      fresh.added = want;
    };
    const overrides: Partial<Record<keyof KernelFs, unknown>> = {
      writeFile: async (path: string, content: Uint8Array | string, owner?: unknown) => {
        await fs.writeFile(path, content, owner as never);
        await decide(path, content);
      },
      chmod: async (path: string, mode: number) => {
        const fresh = this.fresh.get(normalizePath(path));
        const creating = fresh?.added === 0 && (mode & 0o7777) === (0o666 & ~fresh.umask);
        if (!creating) this.fresh.delete(normalizePath(path));
        await fs.chmod(path, mode);
      },
      rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
        this.fresh.delete(normalizePath(path));
        await fs.rm(path, options);
      },
      rename: async (from: string, to: string) => {
        await fs.rename(from, to);
        const fresh = this.fresh.get(normalizePath(from));
        this.fresh.delete(normalizePath(from));
        this.fresh.delete(normalizePath(to));
        if (fresh) this.fresh.set(normalizePath(to), fresh);
      },
    };
    const ranged = rangedOps(fs);
    if (ranged) {
      overrides.pwrite = async (
        path: string,
        at: number,
        bytes: Uint8Array,
        transfer?: boolean
      ) => {
        const head =
          at === 0 && this.fresh.has(normalizePath(path)) ? bytes.slice(0, 4) : undefined;
        await ranged.pwrite(path, at, bytes, transfer);
        if (head) await decide(path, head);
      };
    }
    return new Proxy(fs, {
      get(target, key, receiver) {
        if (Object.hasOwn(overrides, key)) return overrides[key as keyof KernelFs];
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}
