export interface RemoteChange {
  paths: readonly string[];
  trees: readonly string[];
}

export interface PeerRename {
  from: string;
  to: string;
  lock: string;
}

export type RemoteListener = (change: RemoteChange) => void;

export const ANNOUNCE_WAIT_MS = 500;
export const PRUNE_EVERY_MS = 30_000;
export const MOURN_TRIES = 5;
export const MOURN_RETRY_MS = 100;
export const RENAME_ACK_MAX_MS = 10_000;
export const ANNOUNCE_POLL_MS = 20;

interface WatchMessage {
  hello?: string;
  here?: string;
  to?: string;
  tab?: string;
  seq?: number;
  paths?: string[];
  ack?: number;
  from?: string;
  changed?: string[];
  renames?: true;
  renaming?: PeerRename;
  renamed?: string;
}

export interface LockManagerLike {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: Array<{ name?: string }>; pending?: Array<{ name?: string }> }>;
}

export function lockManager(): LockManagerLike | undefined {
  return (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
}

export class RemoteWatch {
  private readonly channel: BroadcastChannel;
  private readonly name: string;
  private readonly tab = crypto.randomUUID();
  private readonly peers = new Set<string>();
  private readonly mourned = new Set<string>();
  private readonly others = new Map<string, readonly string[]>();
  private readonly union = new Set<string>();
  private readonly listeners = new Set<RemoteListener>();
  private readonly waiting = new Map<number, { left: Set<string>; done: () => void }>();
  private readonly locks: LockManagerLike | undefined;
  private mine: readonly string[] = [];
  private seq = 0;
  private pruned = 0;
  private readonly joined: Promise<void>;
  private met: (() => void) | undefined;
  private settled = false;
  quiet: (() => Promise<void>) | undefined;
  crowd: ((crowded: boolean) => void) | undefined;
  gone: (() => void) | undefined;
  renaming: ((rename: PeerRename) => Promise<void>) | undefined;
  renamed: ((lock: string) => void) | undefined;
  private readonly ackers = new Set<string>();
  private told: boolean | undefined;
  private counted = 0;

  private recount(): void {
    const now = this.crowded();
    if (now === this.told && this.peers.size === this.counted) return;
    this.told = now;
    this.counted = this.peers.size;
    this.crowd?.(now);
  }

  constructor(name: string, options: { locks?: LockManagerLike | null } = {}) {
    this.name = name;
    this.locks = options.locks === undefined ? lockManager() : (options.locks ?? undefined);
    this.channel = new BroadcastChannel(name);
    this.channel.onmessage = ({ data }) => this.receive(data as WatchMessage);
    (this.channel as BroadcastChannel & { unref?: () => void }).unref?.();
    const granted = new Promise<void>((resolve) => {
      void this.locks?.request(this.lockOf(this.tab), () => {
        resolve();
        return new Promise<void>(() => {});
      });
      if (!this.locks) resolve();
    });
    this.joined = granted
      .then(() => this.join())
      .then(() => {
        this.settled = true;
        this.recount();
      });
    this.channel.postMessage({ hello: this.tab, renames: true });
  }

  private async join(): Promise<void> {
    if (!this.locks) return;
    const prefix = `${this.name}:`;
    const mine = this.lockOf(this.tab);
    const held = ((await this.locks.query()).held ?? []).map((lock) => lock.name ?? '');
    if (!held.some((name) => name.startsWith(prefix) && name !== mine) || this.peers.size > 0)
      return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ANNOUNCE_WAIT_MS);
      this.met = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async peered(): Promise<boolean> {
    await this.joined;
    return this.peers.size > 0;
  }

  async joinedAll(cap: number): Promise<boolean> {
    if (!this.locks) return true;
    const prefix = `${this.name}:`;
    const began = performance.now();
    for (;;) {
      const held = ((await this.locks.query()).held ?? []).map((lock) => lock.name ?? '');
      const silent = held.some(
        (name) =>
          name.startsWith(prefix) &&
          name !== this.lockOf(this.tab) &&
          !this.peers.has(name.slice(prefix.length))
      );
      if (!silent) return true;
      if (performance.now() - began >= cap) return false;
      await new Promise((resolve) => setTimeout(resolve, ANNOUNCE_POLL_MS));
    }
  }

  crowded(): boolean {
    return !this.settled || this.peers.size > 0;
  }

  private lockOf(tab: string): string {
    return `${this.name}:${tab}`;
  }

  private receive(data: WatchMessage): void {
    const sender = data.hello ?? data.here;
    if (sender !== undefined && data.renames) this.ackers.add(sender);
    if (data.hello !== undefined) this.greeted(data.hello);
    if (data.renaming !== undefined && data.tab !== undefined) this.heard(data);
    if (data.renamed !== undefined) this.renamed?.(data.renamed);
    if (data.here !== undefined && data.to === this.tab) {
      this.arrived(data.here);
      this.met?.();
    }
    if (data.tab !== undefined && data.paths !== undefined) this.announced(data);
    if (data.ack !== undefined && data.to === this.tab && data.from !== undefined) {
      this.acked(data.ack, data.from);
    }
    if (data.changed !== undefined) this.emit({ paths: data.changed, trees: [] });
  }

  private arrived(peer: string): void {
    this.peers.add(peer);
    this.recount();
    void this.mourn(peer);
  }

  private async mourn(peer: string, tries = MOURN_TRIES): Promise<void> {
    if (!this.locks || this.mourned.has(peer)) return;
    this.mourned.add(peer);
    const name = this.lockOf(peer);
    const { held = [], pending = [] } = await this.locks.query();
    if (![...held, ...pending].some((lock) => lock.name === name)) {
      this.mourned.delete(peer);
      if (tries > 1 && this.peers.has(peer)) {
        setTimeout(() => void this.mourn(peer, tries - 1), MOURN_RETRY_MS);
      }
      return;
    }
    void this.locks.request(name, async () => {
      this.mourned.delete(peer);
      this.others.delete(peer);
      this.peers.delete(peer);
      this.ackers.delete(peer);
      this.rebuild();
      this.recount();
      this.gone?.();
      for (const wait of this.waiting.values()) {
        if (wait.left.delete(peer) && wait.left.size === 0) wait.done();
      }
    });
  }

  private greeted(peer: string): void {
    this.arrived(peer);
    const answer = () => {
      this.channel.postMessage({ here: this.tab, to: peer, renames: true });
      if (this.mine.length > 0) void this.announce(this.mine);
    };
    if (this.quiet) void this.quiet().then(answer, answer);
    else answer();
  }

  private heard({ tab, renaming, seq }: WatchMessage): void {
    const ack = () => this.channel.postMessage({ ack: seq, from: this.tab, to: tab });
    const heard = this.renaming?.(renaming as PeerRename);
    if (heard !== undefined) void heard.then(ack, ack);
    else ack();
  }

  private announced({ tab, paths, seq }: WatchMessage): void {
    const from = tab as string;
    this.arrived(from);
    if ((paths as string[]).length > 0) this.others.set(from, paths as string[]);
    else this.others.delete(from);
    this.rebuild();
    this.channel.postMessage({ ack: seq, from: this.tab, to: from });
  }

  private acked(seq: number, from: string): void {
    const wait = this.waiting.get(seq);
    if (!wait) return;
    wait.left.delete(from);
    if (wait.left.size === 0) wait.done();
  }

  private rebuild(): void {
    this.union.clear();
    for (const paths of this.others.values()) for (const path of paths) this.union.add(path);
  }

  async prune(): Promise<void> {
    if (!this.locks) return;
    const held = new Set(((await this.locks.query()).held ?? []).map((lock) => lock.name));
    let left = false;
    for (const tab of new Set([...this.others.keys(), ...this.peers])) {
      if (!held.has(this.lockOf(tab))) {
        if (this.peers.delete(tab)) left = true;
        this.others.delete(tab);
        this.ackers.delete(tab);
      }
    }
    this.rebuild();
    this.recount();
    if (left) this.gone?.();
  }

  watched(): boolean {
    return this.union.size > 0;
  }

  wrote(path: string): void {
    if (!this.union.has(path) && !this.crowded()) return;
    this.channel.postMessage({ changed: [path] });
    const now = Date.now();
    if (now - this.pruned < PRUNE_EVERY_MS) return;
    this.pruned = now;
    void this.prune();
  }

  announce(paths: readonly string[]): Promise<void> {
    this.mine = [...paths];
    const seq = ++this.seq;
    this.channel.postMessage({ tab: this.tab, paths: this.mine, seq });
    return this.acks(seq, this.peers);
  }

  renamingTree(rename: PeerRename, cap = RENAME_ACK_MAX_MS): Promise<string[]> {
    const seq = ++this.seq;
    this.channel.postMessage({ tab: this.tab, renaming: rename, seq });
    const left = new Set(this.ackers);
    if (left.size === 0) return Promise.resolve([]);
    const began = performance.now();
    return new Promise<string[]>((resolve) => {
      const done = () => {
        clearInterval(timer);
        this.waiting.delete(seq);
        resolve([...left]);
      };
      const timer = setInterval(() => {
        void this.prune().then(() => {
          for (const peer of left) if (!this.ackers.has(peer)) left.delete(peer);
          if (left.size === 0 || performance.now() - began >= cap) done();
        });
      }, ANNOUNCE_WAIT_MS);
      this.waiting.set(seq, { left, done });
    });
  }

  renamedTree(lock: string): void {
    this.channel.postMessage({ renamed: lock });
  }

  private acks(seq: number, from: ReadonlySet<string>): Promise<void> {
    if (from.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiting.delete(seq);
        resolve();
      };
      const timer = setTimeout(() => {
        done();
        void this.prune();
      }, ANNOUNCE_WAIT_MS);
      this.waiting.set(seq, { left: new Set(from), done });
    });
  }

  emit(change: RemoteChange): void {
    for (const listener of this.listeners) listener(change);
  }

  listen(listener: RemoteListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
