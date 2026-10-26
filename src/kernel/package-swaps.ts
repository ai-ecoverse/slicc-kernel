import type { KernelFs } from '../fs/types.ts';
import { parentOf } from '../fs/walk.ts';

export const SWAP_GAP_MS = 2000;

function staged(source: string, target: string): boolean {
  const dir = parentOf(target);
  return parentOf(source) === dir && source.length > target.length && source.startsWith(target);
}

interface Gap {
  release: () => void;
  done: () => void;
  settled: Promise<void>;
  timer: ReturnType<typeof setTimeout> | undefined;
  landing: number;
  opened: number;
}

export interface SwapCounts {
  swaps: number;
  longestMs: number;
  waits: number;
  waitedMs: number;
}

export class PackageSwaps {
  private readonly gaps = new Map<string, Gap>();
  private readonly isRoot: (path: string) => boolean;
  private readonly hold: (root: string) => Promise<() => void>;
  private readonly closed: () => void;
  private readonly gapMs: number;
  private readonly tally: SwapCounts = { swaps: 0, longestMs: 0, waits: 0, waitedMs: 0 };

  constructor(
    isRoot: (path: string) => boolean,
    hold: (root: string) => Promise<() => void>,
    closed: () => void,
    gapMs = SWAP_GAP_MS
  ) {
    this.isRoot = isRoot;
    this.hold = hold;
    this.closed = closed;
    this.gapMs = gapMs;
  }

  counts(): SwapCounts {
    return { ...this.tally };
  }

  settled(): Promise<void> {
    if (this.gaps.size === 0) return Promise.resolve();
    const started = performance.now();
    this.tally.waits++;
    return Promise.all([...this.gaps.values()].map((gap) => gap.settled)).then(() => {
      this.tally.waitedMs += performance.now() - started;
    });
  }

  wrap(fs: KernelFs): KernelFs {
    return { ...fs, rename: (from, to) => this.rename(fs, from, to) };
  }

  private async rename(fs: KernelFs, from: string, to: string): Promise<void> {
    const source = fs.resolvePath('/', from);
    const target = fs.resolvePath('/', to);
    const gap = this.gaps.get(target);
    if (gap) return this.land(gap, target, () => fs.rename(from, to));
    if (
      source === target ||
      this.gaps.has(source) ||
      staged(source, target) ||
      !this.isRoot(source)
    ) {
      return fs.rename(from, to);
    }
    const release = await this.hold(source);
    let kept = false;
    try {
      await fs.rename(from, to);
      kept = await fs.stat(`${target}/package.json`).then(
        (st) => st.isFile,
        () => false
      );
      if (kept) this.open(source, release);
    } finally {
      if (!kept) release();
    }
  }

  private open(root: string, release: () => void): void {
    const { promise, resolve } = Promise.withResolvers<void>();
    const gap: Gap = {
      release,
      done: () => resolve(),
      settled: promise,
      timer: undefined,
      landing: 0,
      opened: performance.now(),
    };
    this.gaps.set(root, gap);
    this.tally.swaps++;
    this.arm(root, gap);
  }

  private arm(root: string, gap: Gap): void {
    const timer = setTimeout(() => this.close(root, gap), this.gapMs);
    (timer as { unref?: () => void }).unref?.();
    gap.timer = timer;
  }

  private close(root: string, gap: Gap): void {
    if (this.gaps.get(root) !== gap) return;
    clearTimeout(gap.timer);
    this.gaps.delete(root);
    this.tally.longestMs = Math.max(this.tally.longestMs, performance.now() - gap.opened);
    this.closed();
    gap.done();
    gap.release();
  }

  private async land(gap: Gap, root: string, run: () => Promise<void>): Promise<void> {
    gap.landing++;
    clearTimeout(gap.timer);
    try {
      await run();
    } catch (err) {
      gap.landing--;
      if (gap.landing === 0 && this.gaps.get(root) === gap) this.arm(root, gap);
      throw err;
    }
    this.close(root, gap);
  }
}
