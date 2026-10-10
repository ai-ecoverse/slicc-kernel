import { defaultAction, SIG, sigbit } from '../../kernel/signals.ts';
import type { SignalHooks } from '../process-signals.ts';

const DELIVERED_MASK = Object.values(SIG)
  .filter((sig) => sig !== SIG.KILL && sig !== SIG.STOP)
  .reduce((m, sig) => m | sigbit(sig), 0);

export class WasiSignals implements SignalHooks {
  private exports: WebAssembly.Exports | undefined;
  private callback: string | undefined;

  private uncaught = 0;

  private delivering: number | undefined;

  private defaulted = false;

  private readonly fallBack: (sig: number) => void;
  private readonly onKilled: ((code: number) => void) | undefined;
  constructor(fallBack: (sig: number) => void, onKilled?: (code: number) => void) {
    this.fallBack = fallBack;
    this.onKilled = onKilled;
  }

  killed(code: number): void {
    this.onKilled?.(code);
  }

  bind(exports: WebAssembly.Exports): void {
    this.exports = exports;
  }

  register(name: string): void {
    if (typeof this.exports?.[name] === 'function') this.callback = name;
  }

  masks(): { caught: number; ignored: number; restart: number } | null {
    if (!this.handler()) return null;
    return { caught: DELIVERED_MASK & ~this.uncaught, ignored: 0, restart: 0 };
  }

  raise(sig: number): void {
    const handler = this.handler();
    if (!handler) return;
    const outer = { sig: this.delivering, defaulted: this.defaulted };
    this.delivering = sig;
    this.defaulted = false;
    try {
      handler(sig);
    } catch (e) {
      if (!(e instanceof WebAssembly.RuntimeError)) throw e;
      if (!this.defaulted) this.defaultAction(sig);
    } finally {
      this.delivering = outer.sig;
      this.defaulted = outer.defaulted;
    }
  }

  raised(sig: number): boolean {
    if (sig !== SIG.ABRT || this.delivering === undefined) return false;
    if (!this.defaulted) this.defaultAction(this.delivering);
    return true;
  }

  private defaultAction(sig: number): void {
    this.defaulted = true;
    this.uncaught |= sigbit(sig);
    this.fallBack(sig);
    if (defaultAction(sig) !== 'terminate') this.uncaught &= ~sigbit(sig);
  }

  private handler(): ((sig: number) => void) | undefined {
    const fn = this.callback ? this.exports?.[this.callback] : undefined;
    return typeof fn === 'function' ? (fn as (sig: number) => void) : undefined;
  }
}
