import { SpawnError } from '../kernel/children.ts';
import type { IsolateGate } from './isolates.ts';

export const ISOLATE_MEMORY_BUDGET = 64 * 2 ** 20;
export const INSTANCE_ALLOWANCE = 8 * 2 ** 20;
export const MODULE_ALLOWANCE_FACTOR = 3;
export const MAX_SHARDS = 8;
export const DEPTH_RESERVE = 2;

export interface PlacementOptions {
  budget?: number;
  perInstance?: number;
  waitMs: number;
}

export interface Seat {
  readonly id: string;
  readonly shard: number;
  readonly image: string;
  readonly depth: number;
  readonly forking: number;
  memory(bytes: number): void;
  hold(bytes: number): () => void;
  release(): void;
}

export interface ImageSize {
  image: string;
  base: string;
  initial: number;
  module: number;
}

interface Shard {
  readonly id: string;
  readonly index: number;
  readonly module: number;
  readonly seats: Set<SeatState>;
  release: (() => void) | undefined;
}

interface SeatState {
  bytes: number;
  held: number;
  holds: number;
  released: boolean;
}

export function shardId(base: string, index: number): string {
  return index === 0 ? base : `${base}~${index}`;
}

export class Placement {
  private readonly shards = new Map<string, Shard>();
  private readonly waiters = new Set<() => void>();
  private readonly gate: IsolateGate;
  readonly budget: number;
  readonly perInstance: number;
  readonly waitMs: number;
  peakShards = 0;

  constructor(gate: IsolateGate, options: PlacementOptions) {
    this.gate = gate;
    this.budget = options.budget ?? ISOLATE_MEMORY_BUDGET;
    this.perInstance = options.perInstance ?? INSTANCE_ALLOWANCE;
    this.waitMs = options.waitMs;
  }

  shardsOf(base: string): number[] {
    const out: number[] = [];
    for (const shard of this.shards.values()) {
      if (shard.seats.size > 0 && shardId(base, shard.index) === shard.id) out.push(shard.index);
    }
    return out.sort((a, b) => a - b);
  }

  used(id: string): number {
    const shard = this.shards.get(id);
    if (!shard) return 0;
    let total = 0;
    for (const seat of shard.seats) total += seat.bytes + this.perInstance;
    return total;
  }

  describe(): Record<string, { seats: number; used: number; pending: number; holds: number[] }> {
    const out: Record<string, { seats: number; used: number; pending: number; holds: number[] }> =
      {};
    for (const shard of this.shards.values()) {
      out[shard.id.slice(-12)] = {
        seats: shard.seats.size,
        holds: [...shard.seats].map((seat) => seat.holds),
        used: Math.round(this.used(shard.id) / 2 ** 20),
        pending: Math.round(this.pending(shard.id) / 2 ** 20),
      };
    }
    return out;
  }

  private pending(id: string): number {
    let total = 0;
    for (const seat of this.shards.get(id)?.seats ?? []) total += seat.held;
    return total;
  }

  private expected(size: ImageSize): number {
    let largest = size.initial;
    for (const shard of this.shards.values()) {
      if (!shard.id.startsWith(size.base)) continue;
      for (const seat of shard.seats) largest = Math.max(largest, seat.bytes);
    }
    return largest;
  }

  private fits(shard: Shard, size: ImageSize, need: number, credit = 0): boolean {
    if (shard.seats.size === 0) return true;
    const base = size.module * MODULE_ALLOWANCE_FACTOR;
    const used = this.used(shard.id) + Math.max(0, this.pending(shard.id) - credit);
    return base + used + need + this.perInstance <= this.budget;
  }

  private perShard(size: ImageSize, need: number): number {
    const room = this.budget - size.module * MODULE_ALLOWANCE_FACTOR;
    return Math.max(1, Math.floor(room / (need + this.perInstance)));
  }

  spare(size: ImageSize, need: number): number {
    let spare = 0;
    let shards = 0;
    for (const shard of this.shards.values()) {
      if (shard.seats.size === 0 || !shard.id.startsWith(size.base)) continue;
      shards++;
      const used = this.used(shard.id) + this.pending(shard.id);
      const room = this.budget - size.module * MODULE_ALLOWANCE_FACTOR - used;
      spare += Math.max(0, Math.floor(room / (need + this.perInstance)));
    }
    const free = this.gate.max - this.gate.active - (shards > 0 ? 1 : 0);
    const fresh = Math.max(0, Math.min(free, MAX_SHARDS - shards));
    return spare + fresh * this.perShard(size, need);
  }

  private seat(shard: Shard, size: ImageSize, need: number, depth = 0): Seat {
    if (shard.seats.size === 0) {
      const release = this.gate.tryAcquire(shard.id);
      if (!release) throw new Error('isolate gate refused a placed shard');
      shard.release = release;
    }
    const state: SeatState = { bytes: need, held: 0, holds: 0, released: false };
    shard.seats.add(state);
    this.peakShards = Math.max(this.peakShards, this.shardsOf(size.base).length);
    const seat: Seat = {
      id: shard.id,
      shard: shard.index,
      image: size.image,
      depth,
      get forking() {
        return state.holds;
      },
      memory: (bytes) => {
        if (state.released || !(bytes > 0)) return;
        const shrank = bytes < state.bytes;
        state.bytes = bytes;
        if (shrank) this.wake();
      },
      hold: (bytes) => {
        if (state.released || !(bytes > 0)) return () => {};
        state.held += bytes;
        state.holds++;
        let given = false;
        return () => {
          if (given) return;
          given = true;
          state.held = Math.max(0, state.held - bytes);
          state.holds = Math.max(0, state.holds - 1);
          this.wake();
        };
      },
      release: () => {
        if (state.released) return;
        state.released = true;
        shard.seats.delete(state);
        if (shard.seats.size === 0) {
          const release = shard.release;
          shard.release = undefined;
          this.shards.delete(shard.id);
          release?.();
        }
        this.wake();
      },
    };
    return seat;
  }

  private shard(size: ImageSize, index: number): Shard {
    const id = shardId(size.base, index);
    let shard = this.shards.get(id);
    if (!shard) {
      shard = { id, index, module: size.module, seats: new Set(), release: undefined };
      this.shards.set(id, shard);
    }
    return shard;
  }

  private drop(shard: Shard): void {
    if (shard.seats.size === 0 && !shard.release) this.shards.delete(shard.id);
  }

  private anyLive(): boolean {
    for (const shard of this.shards.values()) if (shard.seats.size > 0) return true;
    return false;
  }

  private lastSlot(): boolean {
    return this.gate.max - this.gate.active <= 1;
  }

  tryOn(size: ImageSize, index: number, need = this.expected(size), depth = 0): Seat | undefined {
    const shard = this.shards.get(shardId(size.base, index));
    if (!shard || shard.seats.size === 0 || !this.fits(shard, size, need, need)) return undefined;
    return this.seat(shard, size, need, depth);
  }

  tryPlace(size: ImageSize, need = this.expected(size), depth = 0): Seat | undefined {
    if (this.spare(size, need) - 1 < Math.max(0, DEPTH_RESERVE - depth)) {
      if (this.anyLive()) return undefined;
    }
    for (let index = 0; index < MAX_SHARDS; index++) {
      const shard = this.shard(size, index);
      if (shard.seats.size > 0) {
        if (this.fits(shard, size, need)) return this.seat(shard, size, need, depth);
        continue;
      }
      if (!this.gate.fits(shard.id) || (index > 0 && this.lastSlot())) {
        this.drop(shard);
        return undefined;
      }
      return this.seat(shard, size, need, depth);
    }
    return undefined;
  }

  async place(size: ImageSize, need?: number, depth = 0, parent?: Seat): Promise<Seat> {
    for (;;) {
      const seat = parent && parent.forking > 1 ? undefined : this.tryPlace(size, need, depth);
      if (seat) return seat;
      if (!(await this.changed())) throw new SpawnError('EAGAIN');
    }
  }

  private wake(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  private changed(): Promise<boolean> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        resolve(false);
      }, this.waitMs);
      this.waiters.add(wake);
    });
  }
}
