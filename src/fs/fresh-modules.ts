import { type KernelFs, normalizePath, rangedOps } from './types.ts';

const MAGIC = [0x00, 0x61, 0x73, 0x6d];
const MAX_FRESH = 65_536;
const DEFAULT_UMASK = 0o022;

interface Fresh {
  umask: number;
  pid: number;
  added: number;
  setup: boolean;
}

function isModule(bytes: Uint8Array): boolean {
  return MAGIC.every((b, i) => bytes[i] === b);
}

function within(path: string, dir: string): boolean {
  return path.startsWith(dir === '/' ? '/' : `${dir}/`);
}

export class FreshModules {
  private readonly fresh = new Map<string, Fresh>();

  add(path: string, umask: number, pid: number): void {
    const key = normalizePath(path);
    this.fresh.delete(key);
    const oldest = this.fresh.size >= MAX_FRESH ? this.fresh.keys().next().value : undefined;
    if (oldest !== undefined) this.fresh.delete(oldest);
    const mask = umask & 0o777;
    this.fresh.set(key, { umask: mask, pid, added: 0, setup: mask !== DEFAULT_UMASK });
  }

  forget(pid: number): void {
    for (const [path, fresh] of this.fresh) if (fresh.pid === pid) this.fresh.delete(path);
  }

  private drop(fresh: Fresh): void {
    for (const [key, note] of [...this.fresh]) if (note === fresh) this.fresh.delete(key);
  }

  private moved(from: string, to: string): void {
    const source = normalizePath(from);
    const target = normalizePath(to);
    if (source === target) return;
    for (const key of [...this.fresh.keys()]) {
      if (key === target || within(key, target)) this.fresh.delete(key);
    }
    for (const [key, fresh] of [...this.fresh]) {
      if (key !== source && !within(key, source)) continue;
      this.fresh.delete(key);
      this.fresh.set(target + key.slice(source.length), fresh);
    }
  }

  wrap(fs: KernelFs): KernelFs {
    const head = async (path: string): Promise<Uint8Array> => {
      if (fs.pread) return fs.pread(path, 0, MAGIC.length);
      return (await fs.readFileBuffer(path)).subarray(0, MAGIC.length);
    };
    const decide = async (given: string, known?: Uint8Array) => {
      const path = normalizePath(given);
      const fresh = this.fresh.get(path);
      if (!fresh) return;
      const bytes = known && known.length >= MAGIC.length ? known : await head(path);
      const want = isModule(bytes) ? 0o111 & ~fresh.umask : 0;
      fresh.setup = false;
      if (want === fresh.added) return;
      const mode = (await fs.stat(path)).mode & 0o7777;
      await fs.chmod(path, (mode & ~fresh.added) | want);
      fresh.added = want;
    };
    const overrides: Partial<Record<keyof KernelFs, unknown>> = {
      writeFile: async (path: string, content: Uint8Array | string, owner?: unknown) => {
        await fs.writeFile(path, content, owner as never);
        if (this.fresh.has(normalizePath(path))) {
          await decide(
            path,
            typeof content === 'string' ? new TextEncoder().encode(content) : content
          );
        }
      },
      chmod: async (path: string, mode: number) => {
        const fresh = this.fresh.get(normalizePath(path));
        if (fresh?.setup && (mode & 0o7777) === (0o666 & ~fresh.umask)) fresh.setup = false;
        else if (fresh) this.drop(fresh);
        await fs.chmod(path, mode);
      },
      rm: async (path: string, options?: Parameters<KernelFs['rm']>[1]) => {
        await fs.rm(path, options);
        const at = normalizePath(path);
        for (const key of [...this.fresh.keys()]) {
          if (key === at || within(key, at)) this.fresh.delete(key);
        }
      },
      rename: async (from: string, to: string) => {
        await fs.rename(from, to);
        this.moved(from, to);
      },
      link: async (from: string, to: string, follow?: boolean) => {
        await fs.link(from, to, follow);
        const source =
          follow && fs.realpath ? await fs.realpath(from, true).catch(() => from) : from;
        const fresh = this.fresh.get(normalizePath(source));
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
        const touches = at < MAGIC.length && this.fresh.has(normalizePath(path));
        const first =
          at === 0 && bytes.length >= MAGIC.length ? bytes.slice(0, MAGIC.length) : undefined;
        await ranged.pwrite(path, at, bytes, transfer);
        if (touches) await decide(path, first);
      };
      overrides.truncate = async (path: string, size: number) => {
        await ranged.truncate(path, size);
        if (size < MAGIC.length && this.fresh.has(normalizePath(path))) await decide(path);
      };
    }
    const bound = new WeakMap<object, unknown>();
    return new Proxy(fs, {
      get(target, key, receiver) {
        if (Object.hasOwn(overrides, key)) return overrides[key as keyof KernelFs];
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== 'function') return value;
        let method = bound.get(value);
        if (method === undefined) {
          method = value.bind(target);
          bound.set(value, method);
        }
        return method;
      },
    });
  }
}
