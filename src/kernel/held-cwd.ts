import type { HeldCwdInit } from './protocol.ts';

export const CWD_SLOTS = 1024;

export const UNTRACKED = CWD_SLOTS - 1;

export interface HeldCwdReply {
  slot?: number;
  seen?: number;
  dead?: boolean;
}

export interface CwdAnswer {
  gen: number;
  alive: boolean;
}

interface Held {
  path: string;
  ino: number | undefined;
  refs: number;
  dead: boolean;
  verified: number;
}

export type InodeOf = (path: string) => Promise<number | undefined>;

const under = (path: string, changed: string): boolean =>
  changed === '/' || path === changed || path.startsWith(`${changed}/`);

export class CwdTable {
  readonly sab = new SharedArrayBuffer(CWD_SLOTS * 4);
  private readonly view = new Int32Array(this.sab);
  private readonly held = new Map<number, Held>();
  private readonly free: number[] = [];
  private next = 0;
  checks = 0;
  private readonly inodeOf: InodeOf;

  constructor(inodeOf: InodeOf) {
    this.inodeOf = inodeOf;
  }

  async hold(path: string, from?: number): Promise<number> {
    const shared = from === undefined ? undefined : this.held.get(from);
    if (shared && shared.path === path) return this.share(from);
    const ino = await this.inodeOf(path).catch(() => undefined);
    const slot = this.free.pop() ?? (this.next < UNTRACKED ? this.next++ : UNTRACKED);
    if (slot === UNTRACKED) return slot;
    this.held.set(slot, {
      path,
      ino,
      refs: 1,
      dead: false,
      verified: Atomics.load(this.view, slot),
    });
    return slot;
  }

  share(slot: number | undefined): number {
    const held = slot === undefined ? undefined : this.held.get(slot);
    if (!held) return UNTRACKED;
    held.refs++;
    return slot as number;
  }

  release(slot: number | undefined): void {
    const held = slot === undefined ? undefined : this.held.get(slot);
    if (!held || --held.refs > 0) return;
    this.held.delete(slot as number);
    Atomics.add(this.view, slot as number, 1);
    this.free.push(slot as number);
  }

  stateOf(slot: number): { seen: number; dead: boolean } {
    const held = this.held.get(slot);
    return { seen: held?.verified ?? Atomics.load(this.view, slot), dead: held?.dead === true };
  }

  touched(paths: readonly string[], trees: readonly string[] = []): void {
    if (this.held.size === 0) return;
    for (const [slot, held] of this.held) {
      if (held.dead) continue;
      if (paths.some((p) => under(held.path, p)) || trees.some((t) => under(held.path, t))) {
        Atomics.add(this.view, slot, 1);
      }
    }
  }

  async check(slot: number): Promise<CwdAnswer> {
    this.checks++;
    const gen = Atomics.load(this.view, slot);
    const held = this.held.get(slot);
    if (!held) return { gen, alive: true };
    if (!held.dead) {
      const ino = await this.inodeOf(held.path).catch(() => null);
      held.dead = ino === null || (held.ino !== undefined && ino !== held.ino);
      held.verified = gen;
    }
    return { gen, alive: !held.dead };
  }
}

export class HeldCwd {
  private readonly view: Int32Array;
  private seen: number;
  private dead = false;
  private slot: number;
  private readonly ask: () => CwdAnswer;

  constructor(
    sab: SharedArrayBuffer,
    slot: number,
    ask: () => CwdAnswer,
    state: { seen: number; dead: boolean }
  ) {
    this.view = new Int32Array(sab);
    this.slot = slot;
    this.ask = ask;
    this.seen = state.seen;
    this.dead = state.dead;
  }

  moved(reply: HeldCwdReply): boolean {
    if (reply.slot === undefined) return false;
    this.slot = reply.slot;
    this.seen = reply.seen ?? Atomics.load(this.view, reply.slot);
    this.dead = reply.dead === true;
    return true;
  }

  alive(): boolean {
    if (this.dead) return false;
    if (Atomics.load(this.view, this.slot) === this.seen) return true;
    const answer = this.ask();
    this.seen = answer.gen;
    this.dead = !answer.alive;
    return answer.alive;
  }

  get current(): number {
    return this.slot;
  }
}

export interface HeldOptions {
  cwds?: SharedArrayBuffer;
  cwdSlot?: number;
  cwdState?: { seen: number; dead: boolean };
  cwdCheck?: () => Promise<CwdAnswer>;
  cwdChdir?: (path: string) => Promise<HeldCwdReply>;
}

export function heldInit(o: HeldOptions): { held?: HeldCwdInit } {
  if (!o.cwds || o.cwdSlot === undefined) return {};
  const state = o.cwdState ?? { seen: 0, dead: false };
  return { held: { sab: o.cwds, slot: o.cwdSlot, ...state } };
}

export function heldHooks(o: HeldOptions): Pick<HeldOptions, 'cwdCheck' | 'cwdChdir'> {
  if (!o.cwdCheck || !o.cwdChdir) return {};
  return { cwdCheck: o.cwdCheck, cwdChdir: o.cwdChdir };
}

export function inheritedCwd(chdir: boolean | undefined, parent: number | undefined) {
  return chdir ? undefined : parent;
}
