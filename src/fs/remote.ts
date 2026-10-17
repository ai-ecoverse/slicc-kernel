export interface RemoteChange {
  paths: readonly string[];
  trees: readonly string[];
}

export type RemoteListener = (change: RemoteChange) => void;

export const ANNOUNCE_WAIT_MS = 500;
export const PRUNE_EVERY_MS = 30_000;

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
}

export interface LockManagerLike {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: Array<{ name?: string }> }>;
}

export function lockManager(): LockManagerLike | undefined {
  return (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
}

export class RemoteWatch {
  private readonly channel: BroadcastChannel;
  private readonly name: string;
  private readonly tab = crypto.randomUUID();
  private readonly peers = new Set<string>();
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
      });
    this.channel.postMessage({ hello: this.tab });
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

  crowded(): boolean {
    return !this.settled || this.peers.size > 0;
  }

  private lockOf(tab: string): string {
    return `${this.name}:${tab}`;
  }

  private receive(data: WatchMessage): void {
    if (data.hello !== undefined) this.greeted(data.hello);
    if (data.here !== undefined && data.to === this.tab) {
      this.peers.add(data.here);
      this.met?.();
    }
    if (data.tab !== undefined && data.paths !== undefined) this.announced(data);
    if (data.ack !== undefined && data.to === this.tab && data.from !== undefined) {
      this.acked(data.ack, data.from);
    }
    if (data.changed !== undefined) this.emit({ paths: data.changed, trees: [] });
  }

  private greeted(peer: string): void {
    this.peers.add(peer);
    const answer = () => {
      this.channel.postMessage({ here: this.tab, to: peer });
      if (this.mine.length > 0) void this.announce(this.mine);
    };
    if (this.quiet) void this.quiet().then(answer, answer);
    else answer();
  }

  private announced({ tab, paths, seq }: WatchMessage): void {
    const from = tab as string;
    this.peers.add(from);
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
    for (const tab of new Set([...this.others.keys(), ...this.peers])) {
      if (!held.has(this.lockOf(tab))) {
        this.others.delete(tab);
        this.peers.delete(tab);
      }
    }
    this.rebuild();
  }

  watched(): boolean {
    return this.union.size > 0;
  }

  wrote(path: string): void {
    if (!this.union.has(path)) return;
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
    if (this.peers.size === 0) return Promise.resolve();
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
      this.waiting.set(seq, { left: new Set(this.peers), done });
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
