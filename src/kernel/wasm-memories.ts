import { SpawnError } from './children.ts';

export const DEFAULT_CEILING = 112;
export const CEILING_FLOOR = 16;
const IDLE_MS = 10_000;
const MARGIN = 16;
const DECAY_MS = 60_000;
const DECAY_STEP = 8;

export interface WasmMemoryCount {
  live: number;
  ceiling: number;
  source: 'learned' | 'default' | 'none';
}

export class WasmMemories {
  private live = 0;
  private learned: { ceiling: number; at: number } | undefined;
  private waiters = new Set<() => void>();
  private readonly base: number | undefined;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(ceiling: number | undefined, idleMs = IDLE_MS, now: () => number = Date.now) {
    this.base = ceiling;
    this.idleMs = idleMs;
    this.now = now;
  }

  private ceiling(): number | undefined {
    const learned = this.learned;
    if (!learned) return this.base;
    const steps = Math.floor((this.now() - learned.at) / DECAY_MS);
    const raised = learned.ceiling + steps * DECAY_STEP;
    if (raised < (this.base ?? DEFAULT_CEILING)) return raised;
    this.learned = undefined;
    return this.base;
  }

  count(): WasmMemoryCount {
    const ceiling = this.ceiling();
    const source = this.learned ? 'learned' : ceiling === undefined ? 'none' : 'default';
    return { live: this.live, ceiling: ceiling ?? 0, source };
  }

  started(): void {
    this.progress();
  }

  ended(): void {
    this.live = Math.max(0, this.live - 1);
    this.progress();
  }

  learn(): void {
    const top = this.base ?? DEFAULT_CEILING;
    this.learned = {
      ceiling: Math.min(top, Math.max(CEILING_FLOOR, this.live - 1)),
      at: this.now(),
    };
  }

  near(): boolean {
    const ceiling = this.ceiling();
    return ceiling !== undefined && this.live + MARGIN >= ceiling;
  }

  async admit(): Promise<void> {
    for (let ceiling = this.ceiling(); ceiling !== undefined && this.live >= ceiling; ) {
      if (!(await this.changed())) throw new SpawnError('EAGAIN');
      ceiling = this.ceiling();
    }
    this.live += 1;
    this.progress();
  }

  async refused(): Promise<void> {
    const ceiling = this.ceiling();
    if (ceiling === undefined || this.live >= ceiling) return;
    if (!(await this.changed())) throw new SpawnError('EAGAIN');
  }

  private progress(): void {
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
      }, this.idleMs);
      this.waiters.add(wake);
    });
  }
}

export function defaultCeiling(): number | undefined {
  const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions
    ?.node;
  return node === undefined ? DEFAULT_CEILING : undefined;
}
