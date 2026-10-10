import { SIG, sigbit, signalsIn } from '../kernel/signals.ts';
import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import type { SyncSabTransport } from '../realm/sync-sab-bridge.ts';
import { SAB_I_KILLED, SAB_I_SIGNALS, SAB_I_TIMERS } from '../realm/sync-sab-wire.ts';

export interface SignalHooks {
  masks(): { caught: number; ignored: number; restart: number; defaults?: number } | null;

  raise(sig: number): void;

  timer?(which: number): void;

  killed?(code: number): void;
}

export class SignalGate {
  private reported = { caught: 0, ignored: 0 };
  private restart = 0;

  private lastDelivered = 0;

  private depth = 0;

  private reporting = false;

  private unwinding = false;

  private quieted = 0;

  private readonly raw: SyncSabTransport;

  private readonly header: Int32Array;

  private readonly hooks: SignalHooks;

  constructor(
    raw: SyncSabTransport,

    header: Int32Array,

    hooks: SignalHooks
  ) {
    this.raw = raw;

    this.header = header;

    this.hooks = hooks;
  }

  transport(): SyncSabTransport {
    return {
      call: (req, timeoutMs, label): SyncFsResult => {
        this.report();
        this.depth++;
        try {
          const result = this.raw.call(req, timeoutMs, label);
          this.deliver();
          return result;
        } finally {
          this.depth--;
        }
      },
    };
  }

  restartable(): boolean {
    return this.lastDelivered !== 0 && (this.lastDelivered & ~this.restart) === 0;
  }

  private report(): void {
    if (this.reporting) return;
    this.reporting = true;
    let masks: ReturnType<SignalHooks['masks']>;
    try {
      masks = this.hooks.masks();
    } catch {
      masks = null;
    } finally {
      this.reporting = false;
    }
    if (!masks) return;
    this.restart = masks.restart;
    const { caught, ignored, defaults = 0 } = masks;
    const same = caught === this.reported.caught && ignored === this.reported.ignored;
    if (same && defaults === 0) return;
    this.reported = { caught, ignored };
    const req = { op: 'sig-mask' as const, caught, ignored, ...(defaults ? { defaults } : {}) };
    this.raw.call(req, Number.POSITIVE_INFINITY, 'sig-mask');
  }

  quiet<T>(fn: () => T): T {
    this.quieted++;
    try {
      return fn();
    } finally {
      this.quieted--;
    }
  }

  deliver(): void {
    if (this.quieted > 0) return;
    const killed = Atomics.load(this.header, SAB_I_KILLED);
    if (killed !== 0 && !this.unwinding && this.hooks.killed) {
      this.unwinding = true;
      this.hooks.killed(killed);
    }
    const timers = Atomics.exchange(this.header, SAB_I_TIMERS, 0);
    const pending = Atomics.exchange(this.header, SAB_I_SIGNALS, 0);

    if (this.depth <= 1) this.lastDelivered = pending | (timers & 1 ? sigbit(SIG.ALRM) : 0);
    for (let which = 0; which < 3; which++) {
      if (timers & (1 << which)) this.hooks.timer?.(which);
    }
    for (const sig of signalsIn(pending)) this.hooks.raise(sig);
  }
}
