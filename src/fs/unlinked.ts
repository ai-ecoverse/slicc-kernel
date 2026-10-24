import {
  type FsStat,
  fsError,
  type KernelFs,
  mayLink,
  type NewOwner,
  type PeerKeeps,
} from './types.ts';

export const UNLINKED_DIR = '.slicc-unlinked';

export interface Replacements {
  settled(path: string): Promise<void>;
  missed(path: string): boolean;
  generation(): number;
  changedSince(path: string, gen: number): boolean;
  inFlight?(path: string): boolean;
  landed?(path: string): Promise<void>;
}

export class PathMarks {
  private gen = 0;
  private floor = 0;
  private readonly touched = new Map<string, number>();
  private readonly flying = new Map<string, number>();
  private readonly waiting = new Set<() => void>();

  generation(): number {
    return this.gen;
  }

  touch(target: string): void {
    this.gen += 1;
    this.touched.delete(target);
    this.touched.set(target, this.gen);
    if (this.touched.size <= TOUCHED_MAX) return;
    const [oldest, at] = this.touched.entries().next().value as [string, number];
    this.touched.delete(oldest);
    this.floor = at;
  }

  changedSince(path: string, gen: number): boolean {
    if (gen < this.floor) return true;
    for (let p = path; this.touched.size > 0; p = parentOf(p)) {
      if ((this.touched.get(p) ?? 0) > gen) return true;
      if (p === '/') return false;
    }
    return false;
  }

  async around<T>(paths: readonly string[], op: () => Promise<T>): Promise<T> {
    for (const p of paths) {
      this.flying.set(p, (this.flying.get(p) ?? 0) + 1);
      this.touch(p);
    }
    try {
      return await op();
    } finally {
      for (const p of paths) {
        const n = (this.flying.get(p) ?? 1) - 1;
        if (n > 0) this.flying.set(p, n);
        else this.flying.delete(p);
        for (const wake of [...this.waiting]) wake();
        this.touch(p);
      }
    }
  }

  async landed(path: string): Promise<void> {
    if (!this.inFlight(path)) return;
    await new Promise<void>((resolve) => {
      const wake = () => {
        if (this.inFlight(path)) return;
        this.waiting.delete(wake);
        resolve();
      };
      this.waiting.add(wake);
    });
  }

  inFlight(path: string): boolean {
    for (let p = path; this.flying.size > 0; p = parentOf(p)) {
      if (this.flying.has(p)) return true;
      if (p === '/') return false;
    }
    return false;
  }
}

interface Replacing {
  done: Promise<void>;
  sealed: boolean;
}

export interface KeptFile {
  readonly hidden: string;
  release(): void;
}

export interface UnlinkHolder {
  held(): Iterable<string>;
  owns(path: string): boolean;
  isKept(path: string): boolean;
  keep(path: string, file: KeptFile): void;
  unkeep(path: string, file: KeptFile): void;
  moving?(path: string): () => void;
}

export interface UnlinkOwner {
  readonly id: string;
  alive(id: string): boolean;
}

export interface UnlinkLocks {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
  query?(): Promise<{ held?: Array<{ name?: string }> }>;
}

export function pidOwner(proc: {
  pid: number;
  kill(pid: number, signal: number): unknown;
}): UnlinkOwner {
  return {
    id: `p${proc.pid}`,
    alive(id) {
      try {
        proc.kill(Number(id.slice(1)), 0);
        return true;
      } catch (err) {
        return (err as { code?: string }).code !== 'ESRCH';
      }
    },
  };
}

export function webLocks(): UnlinkLocks | undefined {
  return (globalThis as { navigator?: { locks?: UnlinkLocks } }).navigator?.locks;
}

const LOOKUP_OPS = [
  'exists',
  'readFile',
  'readFileBuffer',
  'readVersioned',
  'version',
  'pread',
  'readlink',
  'realpath',
] as const;

type LookupOp = (typeof LOOKUP_OPS)[number];

const within = (path: string, target: string) =>
  path === target || target === '/' || path.startsWith(`${target}/`);

const TOUCHED_MAX = 4096;
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

export const PEER_RM_MS = 1000;
export const PEER_RENAME_MS = 10_000;
export const PEER_GATE_MS = PEER_RENAME_MS + 5000;

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
  private readonly owner: UnlinkOwner | undefined;
  private readonly instance: string;
  readonly gate = new PathGate();
  private queue: Promise<unknown> = Promise.resolve();
  private count = 0;
  private readonly replacing = new Map<string, Replacing>();
  private readonly marks: PathMarks;
  private replaced = 0;

  private readonly links = new Map<string, number>();

  private readonly linked = new Map<string, string>();

  private readonly dirOwner: NewOwner | undefined;
  private readonly peers: PeerKeeps | undefined;

  constructor(
    fs: KernelFs,
    holders: Iterable<UnlinkHolder>,
    rootOf: (path: string) => string,
    options: {
      locks?: UnlinkLocks | undefined;
      busy?: (path: string) => boolean;
      owner?: UnlinkOwner | undefined;
      dirOwner?: NewOwner;
      marks?: PathMarks;
      peers?: PeerKeeps | undefined;
    } = {}
  ) {
    this.peers = options.peers;
    this.marks = options.marks ?? new PathMarks();
    const { locks, owner } = options;
    this.dirOwner = options.dirOwner;
    this.fs = fs;
    this.holders = holders;
    this.rootOf = rootOf;
    this.locks = locks;
    this.busy = options.busy ?? (() => false);
    this.owner = owner;
    this.instance = owner ? `${owner.id}~${crypto.randomUUID()}` : crypto.randomUUID();
    void locks?.request(lockName(this.instance), () => new Promise(() => undefined));
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op);
    this.queue = next.catch(() => undefined);
    return next;
  }

  wrap(fs: KernelFs = this.fs): KernelFs {
    const keeper = this;
    const { replacing } = this;
    const replace = async (
      target: string,
      op: (gated: () => void, sealed: () => void) => Promise<void>
    ) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      let mine: Replacing | undefined;
      const gated = () => {
        const before = replacing.get(target);
        mine = { done: Promise.all([before?.done, promise]).then(() => undefined), sealed: false };
        replacing.set(target, mine);
      };
      const sealed = () => {
        if (mine) mine.sealed = true;
      };
      try {
        await keeper.marks.around([target], () => op(gated, sealed));
      } finally {
        keeper.replaced += 1;
        resolve();
        if (mine && replacing.get(target) === mine) replacing.delete(target);
      }
    };
    const unreplaced = async <T>(path: string, op: () => Promise<T>): Promise<T> => {
      const at = fs.resolvePath('/', path);
      const pending = () => keeper.settled(at);
      for (let attempt = 1; ; attempt++) {
        await pending();
        const seen = keeper.replaced;
        try {
          return await op();
        } catch (err) {
          const code = (err as { code?: unknown })?.code;
          if (attempt >= 3 || code !== 'ENOENT') throw err;
          await pending();
          if (keeper.replaced === seen) throw err;
        }
      }
    };
    const looking = <K extends LookupOp>(name: K): Partial<KernelFs> => {
      const call = fs[name] as ((path: string, ...rest: unknown[]) => Promise<unknown>) | undefined;
      if (!call) return {};
      return {
        [name]: (path: string, ...rest: unknown[]) =>
          unreplaced(path, () => call.call(fs, path, ...rest)),
      } as Partial<KernelFs>;
    };
    const visible = (names: string[]) => names.filter((name) => name !== UNLINKED_DIR);
    const counted = (st: FsStat): FsStat => {
      const hidden = keeper.links.get(`${st.dev ?? 0}:${st.ino}`) ?? 0;
      return hidden === 0 || st.nlink === undefined
        ? st
        : { ...st, nlink: Math.max(0, st.nlink - hidden) };
    };
    return {
      ...fs,
      ...LOOKUP_OPS.reduce<Partial<KernelFs>>((all, name) => Object.assign(all, looking(name)), {}),
      links: (path) => mayLink(fs, path),
      stat: (path) => unreplaced(path, async () => counted(await fs.stat(path))),
      lstat: (path) => unreplaced(path, async () => counted(await fs.lstat(path))),
      async rm(path, options) {
        const target = fs.resolvePath('/', path);
        if (await keeper.peerKeep(target, false)) return;
        await replace(target, async (gated, sealed) => {
          const pinned = await keeper.pin(target, gated, sealed);
          if (pinned.moved.has(target)) pinned.commit();
          else await keeper.settle(pinned, () => fs.rm(path, options));
        });
      },
      async rename(from, to) {
        const target = fs.resolvePath('/', to);
        const source = fs.resolvePath('/', from);
        if (target === source) return fs.rename(from, to);
        await keeper.peerKeep(target, true);
        await keeper.marks.around([source], () =>
          replace(target, async (gated, sealed) => {
            const pinned = await keeper.pin(target, gated, sealed);
            await keeper.settle(pinned, () => fs.rename(from, to));
          })
        );
      },
      symlink: (target, path, owner) =>
        keeper.marks.around([fs.resolvePath('/', path)], () => fs.symlink(target, path, owner)),
      readdir: async (path) => visible(await fs.readdir(path)),
      readdirStat: async (path) =>
        (await fs.readdirStat(path))
          .filter(([name]) => name !== UNLINKED_DIR)
          .map(([name, st]) => [name, st && counted(st)]),
    };
  }

  async settled(path: string): Promise<void> {
    for (let p = path; this.replacing.size > 0; p = parentOf(p)) {
      await this.replacing.get(p)?.done;
      if (p === '/') return;
    }
  }

  generation(): number {
    return this.marks.generation();
  }

  changedSince(path: string, gen: number): boolean {
    return this.marks.changedSince(path, gen);
  }

  landed(path: string): Promise<void> {
    return this.marks.landed(path);
  }

  inFlight(path: string): boolean {
    return this.marks.inFlight(path);
  }

  missed(path: string): boolean {
    for (let p = path; this.replacing.size > 0; p = parentOf(p)) {
      if (this.replacing.get(p)?.sealed) return true;
      if (p === '/') return false;
    }
    return false;
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

  private heldWithin(target: string): Map<string, UnlinkHolder[]> {
    const held = new Map<string, UnlinkHolder[]>();
    for (const holder of this.holders) {
      if (holder.owns(target)) continue;
      for (const path of holder.held()) {
        if (!within(path, target) || holder.isKept(path)) continue;
        held.set(path, [...(held.get(path) ?? []), holder]);
      }
    }
    return held;
  }

  async pin(
    target: string,
    gated: () => void = () => undefined,
    sealed: () => void = () => undefined
  ): Promise<Pinned> {
    const paths: string[] = [];
    const releases: Array<() => void> = [];
    const take = async () => {
      for (;;) {
        const fresh = [...this.heldWithin(target).keys()].filter((path) => !paths.includes(path));
        if (fresh.length === 0) return;
        fresh.sort();
        if (paths.some((path) => path > (fresh[0] as string))) {
          for (const release of releases.splice(0)) release();
          fresh.push(...paths.splice(0));
          fresh.sort();
        }
        for (const path of fresh) {
          paths.push(path);
          releases.push(await this.gate.acquire(path));
        }
      }
    };
    await take();
    gated();
    const held = new Map<string, UnlinkHolder[]>();
    const hidden = new Map<string, string>();
    const moved: Array<() => void> = [];
    try {
      for (;;) {
        await take();
        const now = this.heldWithin(target);
        const next = paths.filter((path) => now.has(path) && !held.has(path));
        if (next.length === 0) break;
        for (const path of next) {
          const holders = now.get(path) as UnlinkHolder[];
          held.set(path, holders);
          for (const holder of holders) moved.push(holder.moving?.(path) ?? (() => undefined));
          const at = await this.keepAside(path);
          if (at === undefined) continue;
          hidden.set(path, at);
        }
      }
    } catch (err) {
      for (const [path, at] of hidden) {
        await this.serial(async () => {
          await Promise.allSettled([this.fs.rename(at, path)]);
          this.unlinkedName(at);
        });
      }
      for (const settle of moved) settle();
      for (const release of releases) release();
      throw err;
    }
    sealed();
    const done = () => {
      for (const release of releases) release();
    };
    const files = new Map<string, KeptFile>();
    for (const [path, at] of hidden) {
      const holders = held.get(path) as UnlinkHolder[];
      const file = this.keptFile(at, { refs: holders.length + 1 });
      files.set(path, file);
      for (const holder of holders) holder.keep(path, file);
    }
    for (const settle of moved) settle();
    return {
      moved: new Set(hidden.keys()),
      commit: () => {
        for (const file of files.values()) file.release();
        done();
      },
      rollback: async () => {
        for (const [path, file] of files) {
          for (const holder of held.get(path) as UnlinkHolder[]) holder.unkeep(path, file);
          await this.serial(async () => {
            await Promise.allSettled([this.fs.rename(file.hidden, path)]);
            this.unlinkedName(file.hidden);
            await this.tidy(parentOf(file.hidden));
          });
        }
        done();
      },
    };
  }

  private async keepAside(path: string): Promise<string | undefined> {
    const at = (await this.hide(path)) ?? (await this.hide(path));
    if (at !== undefined || !(await this.present(path))) return at;
    throw fsError('EBUSY', `${path}: open, and it could not be kept aside`);
  }

  private present(path: string): Promise<boolean> {
    return this.fs.lstat(path).then(
      () => true,
      (err: { code?: string }) => err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR'
    );
  }

  get id(): string {
    return this.instance;
  }

  adopt(hidden: string, refs: number): KeptFile {
    return this.keptFile(hidden, { refs });
  }

  async peerKeep(target: string, over: boolean): Promise<boolean> {
    const peers = this.peers;
    if (!peers?.shared() || this.rootOf(target) !== '/') return false;
    const held = peers.heldWithin(target).filter((holder) => holder.instance !== undefined);
    if (held.length === 0) return false;
    const tabs = new Map<string, typeof held>();
    for (const holder of held) tabs.set(holder.tab, [...(tabs.get(holder.tab) ?? []), holder]);
    const asked = [...tabs].map(([tab, holders]) => {
      const paths = holders.map((holder) => holder.path);
      return { tab, holders, paths };
    });
    const heard = await Promise.all(
      asked.map(({ tab, paths }) =>
        peers.ask(tab, { keeping: { paths } }, over ? PEER_RENAME_MS : PEER_RM_MS)
      )
    );
    if (over && heard.includes(false)) {
      for (const { tab, paths } of asked)
        void peers.ask(tab, { kept: { items: [], paths } }, PEER_RM_MS);
      throw fsError('EBUSY', `${target}: open in another tab that did not answer`);
    }
    const mine = this.heldWithin(target);
    const taken = new Set<string>();
    let whole = false;
    const told: Array<Promise<boolean>> = [];
    for (const [i, { tab, holders, paths }] of asked.entries()) {
      const items = [];
      for (const holder of holders) {
        const free = !mine.has(holder.path) && !taken.has(holder.path);
        const hidden = free
          ? await this.asideFor(holder.path, holder.instance as string)
          : undefined;
        if (hidden !== undefined) taken.add(holder.path);
        if (hidden !== undefined && holder.path === target) whole = true;
        items.push({ path: holder.path, hidden, fid: holder.fid });
      }
      const answer = peers.ask(tab, { kept: { items, paths } }, PEER_RM_MS);
      if (heard[i]) told.push(answer);
    }
    await Promise.all(told);
    return whole;
  }

  private async asideFor(path: string, instance: string): Promise<string | undefined> {
    return (await this.hideFor(path, instance)) ?? this.hideFor(path, instance);
  }

  private hideFor(path: string, instance: string): Promise<string | undefined> {
    return this.serial(async () => {
      const dir = dirOf('/');
      const hidden = `${dir}/${instance}.p${crypto.randomUUID().replaceAll('-', '')}`;
      try {
        const owner = this.dirOwner;
        await this.fs.mkdir(dir, { recursive: true, ...(owner ? { owner } : {}) });
        await this.fs.rename(path, hidden);
        return hidden;
      } catch {
        return undefined;
      }
    });
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
        const owner = this.dirOwner;
        await this.fs.mkdir(dir, { recursive: true, ...(owner ? { owner } : {}) });
        await this.fs.rename(path, hidden);
        await this.linkedName(hidden);
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
    this.unlinkedName(hidden);
    await this.tidy(parentOf(hidden));
  }

  private async linkedName(hidden: string): Promise<void> {
    if (!mayLink(this.fs, hidden)) return;
    const st = await this.fs.lstat(hidden).catch(() => undefined);
    if (st?.nlink === undefined) return;
    const id = `${st.dev ?? 0}:${st.ino}`;
    this.linked.set(hidden, id);
    this.links.set(id, (this.links.get(id) ?? 0) + 1);
  }

  private unlinkedName(hidden: string): void {
    const id = this.linked.get(hidden);
    if (id === undefined) return;
    this.linked.delete(hidden);
    const left = (this.links.get(id) ?? 1) - 1;
    if (left > 0) this.links.set(id, left);
    else this.links.delete(id);
  }

  private async tidy(dir: string): Promise<void> {
    const left = await this.fs.readdir(dir).catch(() => [UNLINKED_DIR]);
    if (left.length === 0) await this.fs.rm(dir).catch(() => undefined);
  }

  sweep(root: string): Promise<void> {
    const query = this.locks?.query?.bind(this.locks);
    const owner = this.owner;
    if (!query && !owner) return Promise.resolve();
    return this.serial(async () => {
      const dir = dirOf(root);
      const names = await this.fs.readdir(dir).catch(() => undefined);
      if (!names) return;
      const held = query && new Set(((await query()).held ?? []).map((lock) => lock.name));
      for (const name of names) {
        const id = name.slice(0, name.lastIndexOf('.'));
        const at = id.indexOf('~');
        const dead =
          id !== this.instance &&
          (at < 0
            ? held !== undefined && !held.has(lockName(id))
            : owner?.alive(id.slice(0, at)) === false);
        if (dead) await this.fs.rm(`${dir}/${name}`, { recursive: true }).catch(() => undefined);
      }
      await this.tidy(dir);
    });
  }
}
