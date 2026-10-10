import type { KernelFs } from './types.ts';

export const UNLINKED_DIR = '.slicc-unlinked';

export interface KeptFile {
  readonly hidden: string;
  release(): void;
}

export interface UnlinkHolder {
  readonly opens: ReadonlyMap<string, number>;
  readonly unlinked: Map<string, KeptFile>;
  owns(path: string): boolean;
}

export interface UnlinkLocks {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
  query?(): Promise<{ held?: Array<{ name?: string }> }>;
}

export function webLocks(): UnlinkLocks | undefined {
  return (globalThis as { navigator?: { locks?: UnlinkLocks } }).navigator?.locks;
}

const within = (path: string, target: string) =>
  path === target || target === '/' || path.startsWith(`${target}/`);

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

const lockName = (instance: string) => `slicc-unlinked:${instance}`;

const dirOf = (root: string) => (root === '/' ? `/${UNLINKED_DIR}` : `${root}/${UNLINKED_DIR}`);

export class PathGate {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(path: string): Promise<() => void> {
    const prev = this.tails.get(path) ?? Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const tail = prev.then(() => promise);
    this.tails.set(path, tail);
    await prev;
    return () => {
      resolve();
      if (this.tails.get(path) === tail) this.tails.delete(path);
    };
  }

  async run<T>(path: string, op: () => Promise<T>): Promise<T> {
    const release = await this.acquire(path);
    try {
      return await op();
    } finally {
      release();
    }
  }
}

interface Pinned {
  moved: Set<string>;
  commit(): void;
  rollback(): Promise<void>;
}

export class UnlinkedKeeper {
  private readonly fs: KernelFs;
  private readonly holders: Iterable<UnlinkHolder>;
  private readonly rootOf: (path: string) => string;
  private readonly locks: UnlinkLocks | undefined;
  private readonly busy: (path: string) => boolean;
  private readonly waiting = new Set<string>();
  private readonly instance = crypto.randomUUID();
  readonly gate = new PathGate();
  private queue: Promise<unknown> = Promise.resolve();
  private count = 0;

  constructor(
    fs: KernelFs,
    holders: Iterable<UnlinkHolder>,
    rootOf: (path: string) => string,
    locks?: UnlinkLocks,
    busy: (path: string) => boolean = () => false
  ) {
    this.fs = fs;
    this.holders = holders;
    this.rootOf = rootOf;
    this.locks = locks;
    this.busy = busy;
    void locks?.request(lockName(this.instance), () => new Promise(() => undefined));
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op);
    this.queue = next.catch(() => undefined);
    return next;
  }

  wrap(): KernelFs {
    const fs = this.fs;
    const keeper = this;
    const visible = (names: string[]) => names.filter((name) => name !== UNLINKED_DIR);
    return {
      ...fs,
      async rm(path, options) {
        const target = fs.resolvePath('/', path);
        const pinned = await keeper.pin(target);
        if (pinned.moved.has(target)) pinned.commit();
        else await keeper.settle(pinned, () => fs.rm(path, options));
      },
      async rename(from, to) {
        const pinned = await keeper.pin(fs.resolvePath('/', to));
        await keeper.settle(pinned, () => fs.rename(from, to));
      },
      readdir: async (path) => visible(await fs.readdir(path)),
      readdirStat: async (path) =>
        (await fs.readdirStat(path)).filter(([name]) => name !== UNLINKED_DIR),
    };
  }

  async settle(pinned: Pinned, op: () => Promise<void>): Promise<void> {
    try {
      await op();
    } catch (err) {
      await pinned.rollback();
      throw err;
    }
    pinned.commit();
  }

  async pin(target: string): Promise<Pinned> {
    const held = new Map<string, UnlinkHolder[]>();
    for (const holder of this.holders) {
      if (holder.owns(target)) continue;
      for (const path of holder.opens.keys()) {
        if (!within(path, target) || holder.unlinked.has(path)) continue;
        held.set(path, [...(held.get(path) ?? []), holder]);
      }
    }
    const paths = [...held.keys()].sort();
    const releases: Array<() => void> = [];
    for (const path of paths) releases.push(await this.gate.acquire(path));
    const hidden = new Map<string, string>();
    for (const path of paths) {
      const at = await this.hide(path);
      if (at !== undefined) hidden.set(path, at);
    }
    const done = () => {
      for (const release of releases) release();
    };
    return {
      moved: new Set(hidden.keys()),
      commit: () => {
        for (const [path, at] of hidden) {
          const holders = held.get(path) as UnlinkHolder[];
          const file = this.keptFile(at, { refs: holders.length });
          for (const holder of holders) holder.unlinked.set(path, file);
        }
        done();
      },
      rollback: async () => {
        for (const [path, at] of hidden) {
          await this.serial(async () => {
            await Promise.allSettled([this.fs.rename(at, path)]);
            await this.tidy(parentOf(at));
          });
        }
        done();
      },
    };
  }

  private keptFile(hidden: string, entry: { refs: number }): KeptFile {
    return {
      hidden,
      release: () => {
        if (--entry.refs === 0) void this.serial(() => this.drop(hidden));
      },
    };
  }

  private hide(path: string): Promise<string | undefined> {
    return this.serial(async () => {
      const dir = dirOf(this.rootOf(path));
      const hidden = `${dir}/${this.instance}.${++this.count}`;
      try {
        await this.fs.mkdir(dir, { recursive: true });
        await this.fs.rename(path, hidden);
        return hidden;
      } catch {
        await this.tidy(dir);
        return undefined;
      }
    });
  }

  closed(path: string): void {
    if (this.waiting.delete(path)) void this.serial(() => this.drop(path));
  }

  private async drop(hidden: string): Promise<void> {
    if (this.busy(hidden)) {
      this.waiting.add(hidden);
      return;
    }
    await this.fs.rm(hidden).catch(() => undefined);
    await this.tidy(parentOf(hidden));
  }

  private async tidy(dir: string): Promise<void> {
    const left = await this.fs.readdir(dir).catch(() => [UNLINKED_DIR]);
    if (left.length === 0) await this.fs.rm(dir, { recursive: true }).catch(() => undefined);
  }

  sweep(root: string): Promise<void> {
    const query = this.locks?.query?.bind(this.locks);
    if (!query) return Promise.resolve();
    return this.serial(async () => {
      const dir = dirOf(root);
      const names = await this.fs.readdir(dir).catch(() => undefined);
      if (!names) return;
      const held = new Set(((await query()).held ?? []).map((lock) => lock.name));
      for (const name of names) {
        const owner = name.slice(0, name.lastIndexOf('.'));
        if (owner === this.instance || held.has(lockName(owner))) continue;
        await this.fs.rm(`${dir}/${name}`, { recursive: true }).catch(() => undefined);
      }
      await this.tidy(dir);
    });
  }
}
