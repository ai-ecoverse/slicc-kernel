import { SpawnError } from './children.ts';

export const DEFAULT_CEILING = 112;
const IDLE_MS = 10_000;
const MARGIN = 16;

export interface WasmMemoryCount {
  live: number;
  ceiling: number;
}

export class WasmMemories {
  private live = 0;
  private ceiling: number | undefined;
  private waiters = new Set<() => void>();
  private readonly idleMs: number;

  constructor(ceiling: number | undefined, idleMs = IDLE_MS) {
    this.ceiling = ceiling;
    this.idleMs = idleMs;
  }

  count(): WasmMemoryCount {
    return { live: this.live, ceiling: this.ceiling ?? 0 };
  }

  ended(): void {
    this.live = Math.max(0, this.live - 1);
    this.progress();
  }

  learn(): void {
    this.ceiling = Math.max(1, this.live - 1);
  }

  near(): boolean {
    return this.ceiling !== undefined && this.live + MARGIN >= this.ceiling;
  }

  async admit(): Promise<void> {
    while (this.ceiling !== undefined && this.live >= this.ceiling) {
      if (!(await this.changed())) throw new SpawnError('EAGAIN');
    }
    this.live += 1;
    this.progress();
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
