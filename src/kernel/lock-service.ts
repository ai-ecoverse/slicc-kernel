import { ANNOUNCE_WAIT_MS, type LockManagerLike } from '../fs/remote.ts';
import { KernelError } from './fd-table.ts';
import { type FlockKind, type LockKind, LockTable, type RecordLock } from './locks.ts';

export const PRUNE_MS = 1000;
export const LOCKS_PROTOCOL = 'v1';

type Range = { start: number; end: number };
type Want = { key: string; kind: LockKind } & Range;

type Ask =
  | { op: 'set'; key: string; owner: number; kind: LockKind | 'unlock'; start: number; end: number }
  | { op: 'wait'; key: string; owner: number; kind: LockKind; start: number; end: number }
  | { op: 'holder'; key: string; owner: number; kind: LockKind; start: number; end: number }
  | { op: 'drop'; key: string; owner: number }
  | { op: 'release'; owner: number }
  | { op: 'fset'; key: string; owner: number; kind: FlockKind | 'unlock' }
  | { op: 'fwait'; key: string; owner: number; kind: FlockKind }
  | { op: 'fdrop'; owner: number };

interface Message {
  id?: string;
  from?: string;
  to?: string;
  ask?: Ask;
  ok?: unknown;
  errno?: string;
  cancel?: string;
  reassert?: true;
  adopt?: { records: Array<[string, RecordLock[]]>; flocks: Array<[string, number, FlockKind]> };
}

export interface KernelLocks {
  readonly flocks: {
    set(key: string, owner: object, kind: FlockKind | 'unlock'): boolean | Promise<boolean>;
    wait(key: string, owner: object, kind: FlockKind, blocking: () => AbortSignal): Promise<void>;
    drop(owner: object): void;
  };
  holder(
    key: string,
    owner: number,
    want: Want
  ): RecordLock | undefined | Promise<RecordLock | undefined>;
  set(
    key: string,
    owner: number,
    kind: LockKind | 'unlock',
    start: number,
    end: number
  ): boolean | Promise<boolean>;
  wait(
    key: string,
    owner: number,
    kind: LockKind,
    range: Range,
    blocking: () => AbortSignal
  ): Promise<void>;
  holds(owner: number): boolean;
  dropFile(key: string, owner: number): void;
  release(pid: number): void;
  lock(pid: number, path: string, exclusive: boolean, fd: number): boolean;
  unlock(pid: number, path: string): void;
  closed(pid: number, fd: number): void;
}

interface Pending {
  ask: Ask;
  resolve(value: unknown): void;
  reject(err: unknown): void;
}

export interface LockServiceOptions {
  root: string;
  locks: LockManagerLike & {
    request(
      name: string,
      options: { ifAvailable: true },
      cb: (lock: unknown) => Promise<void>
    ): Promise<unknown>;
  };
  channel?: (name: string) => BroadcastChannel;
}

export class LockService implements KernelLocks {
  readonly kernel = crypto.randomUUID();
  private table = new LockTable();
  private leader = false;
  private readonly role: Promise<void>;
  private readonly channel: BroadcastChannel;
  private readonly locks: LockServiceOptions['locks'];
  private readonly root: string;
  private readonly pending = new Map<string, Pending>();
  private next = 0;
  private readonly owners = new Map<string, number>();
  private readonly ownerOf = new Map<number, { kernel: string; owner: number }>();
  private nextRemote = -1;
  private readonly tokens = new Map<string, object>();
  private readonly flockIds = new WeakMap<object, number>();
  private readonly flockOwners = new Map<number, object>();
  private nextFlock = 1;
  private readonly granted = new Map<string, { errno?: string; ok?: unknown }>();
  private readonly waiting = new Map<string, AbortController>();
  private settled = Promise.resolve();
  private pruner: ReturnType<typeof setInterval> | undefined;
  readonly flocks: KernelLocks['flocks'];

  constructor(options: LockServiceOptions) {
    this.root = options.root;
    this.locks = options.locks;
    this.channel = (options.channel ?? ((n) => new BroadcastChannel(n)))(
      `slicc-locks:${LOCKS_PROTOCOL}:${this.root}`
    );
    (this.channel as BroadcastChannel & { unref?: () => void }).unref?.();
    this.channel.onmessage = ({ data }) => {
      if (isMessage(data)) void this.receive(data);
    };
    void this.locks.request(this.aliveOf(this.kernel), () => new Promise<void>(() => {}));
    this.role = this.elect();
    this.flocks = {
      set: (key, owner, kind) => this.flockSet(key, owner, kind),
      wait: (key, owner, kind, blocking) => this.flockWait(key, owner, kind, blocking),
      drop: (owner) => this.flockDrop(owner),
    };
  }

  private aliveOf(kernel: string): string {
    return `slicc-locks-alive:${LOCKS_PROTOCOL}:${this.root}:${kernel}`;
  }

  private elect(): Promise<void> {
    const name = `slicc-locks-leader:${LOCKS_PROTOCOL}:${this.root}`;
    return new Promise<void>((decided) => {
      void this.locks.request(name, { ifAvailable: true }, async (lock) => {
        this.leader = lock !== null;
        decided();
        if (this.leader) await new Promise<void>(() => {});
      });
    }).then(() => {
      if (this.leader) return;
      void this.locks.request(name, async () => {
        await this.lead();
        await new Promise<void>(() => {});
      });
    });
  }

  private async lead(): Promise<void> {
    this.leader = true;
    this.settled = new Promise<void>((resolve) => setTimeout(resolve, ANNOUNCE_WAIT_MS));
    this.channel.postMessage({ reassert: true, from: this.kernel });
    const pending = [...this.pending.entries()];
    this.pending.clear();
    await this.settled;
    for (const [, p] of pending) void this.serve(p.ask, this.kernel).then(p.resolve, p.reject);
  }

  private async receive(data: Message): Promise<void> {
    if (data.reassert && data.from !== this.kernel) return this.reassert();
    if (data.to !== undefined && data.to !== this.kernel) return;
    if (
      data.id !== undefined &&
      (data.ok !== undefined || data.errno !== undefined) &&
      data.to === this.kernel
    ) {
      return this.answered(data);
    }
    if (!this.leader || data.from === undefined) return;
    if (data.adopt) return this.adopt(data.from, data.adopt);
    if (data.cancel !== undefined) return void this.waiting.get(data.cancel)?.abort();
    if (data.ask && data.id !== undefined) await this.request(data.from, data.id, data.ask);
  }

  private answered(data: Message): void {
    const p = this.pending.get(data.id as string);
    if (!p) return;
    this.pending.delete(data.id as string);
    if (data.errno !== undefined) p.reject(new KernelError(data.errno as never));
    else p.resolve(data.ok);
  }

  private async request(from: string, id: string, ask: Ask): Promise<void> {
    const known = this.granted.get(id);
    if (known) return void this.channel.postMessage({ id, to: from, ...known });
    await this.settled;
    let reply: { ok?: unknown; errno?: string };
    try {
      reply = { ok: (await this.serve(ask, from, id)) ?? null };
    } catch (err) {
      reply = { errno: (err as { code?: string }).code ?? 'EIO' };
    }
    this.granted.set(id, reply);
    if (this.granted.size > 4096) this.granted.delete(this.granted.keys().next().value as string);
    this.channel.postMessage({ id, to: from, ...reply });
  }

  private ownerFor(kernel: string, owner: number): number {
    if (kernel === this.kernel) return owner;
    const name = `${kernel}:${owner}`;
    let id = this.owners.get(name);
    if (id === undefined) {
      id = this.nextRemote--;
      this.owners.set(name, id);
      this.ownerOf.set(id, { kernel, owner });
      this.watchRemotes();
    }
    return id;
  }

  private tokenFor(kernel: string, owner: number): object {
    if (kernel === this.kernel) return this.flockOwners.get(owner) ?? {};
    const name = `${kernel}:${owner}`;
    let token = this.tokens.get(name);
    if (!token) {
      token = { kernel, owner };
      this.tokens.set(name, token);
      this.watchRemotes();
    }
    return token;
  }

  private async serve(ask: Ask, from: string, id?: string): Promise<unknown> {
    const t = this.table;
    switch (ask.op) {
      case 'set':
        return t.set(ask.key, this.ownerFor(from, ask.owner), ask.kind, ask.start, ask.end);
      case 'holder': {
        const held = t.holder(ask.key, this.ownerFor(from, ask.owner), ask);
        if (!held) return undefined;
        return { ...held, owner: this.ownerOf.get(held.owner)?.owner ?? held.owner };
      }
      case 'wait':
        return this.blockFor(id, () =>
          t.wait(ask.key, this.ownerFor(from, ask.owner), ask.kind, ask, () => this.signalOf(id))
        );
      case 'drop':
        return t.dropFile(ask.key, this.ownerFor(from, ask.owner));
      case 'release':
        return t.release(this.ownerFor(from, ask.owner));
      case 'fset':
        return t.flocks.set(ask.key, this.tokenFor(from, ask.owner), ask.kind);
      case 'fwait':
        return this.blockFor(id, () =>
          t.flocks.wait(ask.key, this.tokenFor(from, ask.owner), ask.kind, () => this.signalOf(id))
        );
      case 'fdrop':
        return t.flocks.drop(this.tokenFor(from, ask.owner));
    }
  }

  private signalOf(id: string | undefined): AbortSignal {
    if (id === undefined) return new AbortController().signal;
    let c = this.waiting.get(id);
    if (!c) {
      c = new AbortController();
      this.waiting.set(id, c);
    }
    return c.signal;
  }

  private async blockFor(id: string | undefined, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } finally {
      if (id !== undefined) this.waiting.delete(id);
    }
  }

  private watchRemotes(): void {
    if (this.pruner || (this.ownerOf.size === 0 && this.tokens.size === 0)) return;
    this.pruner = setInterval(() => void this.prune(), PRUNE_MS);
    (this.pruner as { unref?: () => void }).unref?.();
  }

  async prune(): Promise<void> {
    const held = new Set(((await this.locks.query()).held ?? []).map((l) => l.name));
    for (const [id, { kernel, owner }] of [...this.ownerOf]) {
      if (held.has(this.aliveOf(kernel))) continue;
      this.table.release(id);
      this.ownerOf.delete(id);
      this.owners.delete(`${kernel}:${owner}`);
    }
    for (const [name, token] of [...this.tokens]) {
      if (held.has(this.aliveOf(name.slice(0, name.lastIndexOf(':'))))) continue;
      this.table.flocks.drop(token);
      this.tokens.delete(name);
    }
    if (this.pruner && this.ownerOf.size === 0 && this.tokens.size === 0) {
      clearInterval(this.pruner);
      this.pruner = undefined;
    }
  }

  private reassert(): void {
    const records: Array<[string, RecordLock[]]> = this.table.entries();
    const flocks = this.table.flocks
      .entries()
      .map(([key, owner, kind]): [string, number, FlockKind] => [key, this.flockIdOf(owner), kind]);
    this.channel.postMessage({ adopt: { records, flocks }, from: this.kernel });
    for (const [id, p] of this.pending)
      this.channel.postMessage({ id, from: this.kernel, ask: p.ask });
  }

  private adopt(from: string, held: NonNullable<Message['adopt']>): void {
    for (const [key, locks] of held.records)
      for (const l of locks)
        this.table.set(key, this.ownerFor(from, l.owner), l.kind, l.start, l.end);
    for (const [key, owner, kind] of held.flocks)
      this.table.flocks.set(key, this.tokenFor(from, owner), kind);
  }

  private flockIdOf(owner: object): number {
    let id = this.flockIds.get(owner);
    if (id === undefined) {
      id = this.nextFlock++;
      this.flockIds.set(owner, id);
      this.flockOwners.set(id, owner);
    }
    return id;
  }

  private async ask(ask: Ask, signal?: AbortSignal): Promise<unknown> {
    await this.role;
    await this.settled;
    if (this.leader) return this.serve(ask, this.kernel);
    const id = `${this.kernel}:${this.next++}`;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { ask, resolve, reject });
      this.channel.postMessage({ id, from: this.kernel, ask });
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.delete(id)) return;
          this.channel.postMessage({ cancel: id, from: this.kernel });
          reject(new KernelError('EINTR'));
        },
        { once: true }
      );
    });
  }

  async holder(key: string, owner: number, want: Want): Promise<RecordLock | undefined> {
    return ((await this.ask({
      op: 'holder',
      key,
      owner,
      kind: want.kind,
      start: want.start,
      end: want.end,
    })) ?? undefined) as RecordLock | undefined;
  }

  async set(
    key: string,
    owner: number,
    kind: LockKind | 'unlock',
    start: number,
    end: number
  ): Promise<boolean> {
    const ok = (await this.ask({ op: 'set', key, owner, kind, start, end })) === true;
    if (ok && !this.leader) this.table.set(key, owner, kind, start, end);
    return ok;
  }

  async wait(
    key: string,
    owner: number,
    kind: LockKind,
    range: Range,
    blocking: () => AbortSignal
  ): Promise<void> {
    await this.role;
    await this.settled;
    if (this.leader) return this.table.wait(key, owner, kind, range, blocking);
    if (await this.set(key, owner, kind, range.start, range.end)) return;
    await this.ask({ op: 'wait', key, owner, kind, ...range }, blocking());
    if (!this.leader) this.table.set(key, owner, kind, range.start, range.end);
  }

  holds(owner: number): boolean {
    return this.table.holds(owner);
  }

  dropFile(key: string, owner: number): void {
    if (!this.leader) this.table.dropFile(key, owner);
    void this.ask({ op: 'drop', key, owner }).catch(() => undefined);
  }

  release(pid: number): void {
    if (!this.leader) this.table.release(pid);
    void this.ask({ op: 'release', owner: pid }).catch(() => undefined);
  }

  private async flockSet(key: string, owner: object, kind: FlockKind | 'unlock'): Promise<boolean> {
    await this.role;
    await this.settled;
    if (this.leader) return this.table.flocks.set(key, owner, kind);
    const ok = (await this.ask({ op: 'fset', key, owner: this.flockIdOf(owner), kind })) === true;
    if (ok) this.table.flocks.set(key, owner, kind);
    return ok;
  }

  private async flockWait(
    key: string,
    owner: object,
    kind: FlockKind,
    blocking: () => AbortSignal
  ): Promise<void> {
    await this.role;
    await this.settled;
    if (this.leader) return this.table.flocks.wait(key, owner, kind, blocking);
    if (await this.flockSet(key, owner, kind)) return;
    await this.ask({ op: 'fwait', key, owner: this.flockIdOf(owner), kind }, blocking());
    if (!this.leader) this.table.flocks.set(key, owner, kind);
  }

  private flockDrop(owner: object): void {
    if (!this.leader) this.table.flocks.drop(owner);
    void this.ask({ op: 'fdrop', owner: this.flockIdOf(owner) }).catch(() => undefined);
  }

  lock(pid: number, path: string, exclusive: boolean, fd: number): boolean {
    return this.table.lock(pid, path, exclusive, fd);
  }

  unlock(pid: number, path: string): void {
    this.table.unlock(pid, path);
  }

  closed(pid: number, fd: number): void {
    this.table.closed(pid, fd);
  }
}

type ElectingLocks = LockServiceOptions['locks'];

export function kernelLocks(root: string | undefined): KernelLocks {
  const locks = (globalThis.navigator as { locks?: ElectingLocks } | undefined)?.locks;
  if (root === undefined || !locks || typeof BroadcastChannel !== 'function')
    return new LockTable();
  return new LockService({ root, locks });
}

const ASK_OPS: ReadonlySet<string> = new Set([
  'set',
  'wait',
  'holder',
  'drop',
  'release',
  'fset',
  'fwait',
  'fdrop',
]);

function askOk(ask: unknown): boolean {
  if (typeof ask !== 'object' || ask === null) return false;
  const a = ask as { op?: unknown; key?: unknown; owner?: unknown };
  if (!ASK_OPS.has(String(a.op)) || typeof a.owner !== 'number') return false;
  return a.key === undefined || typeof a.key === 'string';
}

function isMessage(data: unknown): data is Message {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return false;
  const m = data as Record<string, unknown>;
  for (const field of ['id', 'from', 'to', 'cancel', 'errno'])
    if (m[field] !== undefined && typeof m[field] !== 'string') return false;
  if (m.ask !== undefined && !askOk(m.ask)) return false;
  const adopt = m.adopt as { records?: unknown; flocks?: unknown } | null | undefined;
  if (adopt === undefined) return true;
  return adopt !== null && Array.isArray(adopt.records) && Array.isArray(adopt.flocks);
}
