import { defaultAction, SIG, sigbit } from '../../kernel/signals.ts';
import type { SignalHooks } from '../process-signals.ts';
import { E } from './wasi-abi.ts';
import { WasiExit } from './wasi-host.ts';

const DELIVERED_MASK = Object.values(SIG)
  .filter((sig) => sig !== SIG.KILL && sig !== SIG.STOP)
  .reduce((m, sig) => m | sigbit(sig), 0);

const KERNEL_DEFAULTS = [SIG.TSTP, SIG.TTIN, SIG.TTOU, SIG.CHLD, SIG.CONT, SIG.URG, SIG.WINCH]
  .map(sigbit)
  .reduce((m, bit) => m | bit, 0);

const LIBC_DEFAULT_EXIT = 127;

const SA_RESTART = 0x10000000;
const DISPOSITION_IGNORE = 1;
const DISPOSITION_HANDLER = 2;

export interface WasiSignalState {
  callback?: string;
  hooked?: true;
  handlers: number;
  ignoring: number;
  restarting: number;
  uncaught: number;
}

const withBit = (mask: number, bit: number, on: boolean): number => (on ? mask | bit : mask & ~bit);

const WASIX_LIBC_DEFAULT_LINE = /^Program recieved (?:stop|termination|fatal) signal: [^\n]+\n$/;

export class WasiSignals implements SignalHooks {
  private exports: WebAssembly.Exports | undefined;
  private callback: string | undefined;

  private uncaught = 0;

  private delivering: number | undefined;

  private defaulted = false;

  private libcDefault = false;

  private hooked = false;

  private handlers = 0;

  private ignoring = 0;

  private restarting = 0;

  private defaults = 0;

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

  useHook(): void {
    this.hooked = true;
  }

  disposition(sig: number, disposition: number, flags: number): number {
    if (sig < 1 || sig > 31 || (DELIVERED_MASK & sigbit(sig)) === 0) return E.INVAL;
    const bit = sigbit(sig);
    this.handlers = withBit(this.handlers, bit, disposition === DISPOSITION_HANDLER);
    this.ignoring = withBit(this.ignoring, bit, disposition === DISPOSITION_IGNORE);
    this.restarting = withBit(this.restarting, bit, (flags & SA_RESTART) !== 0);
    this.defaults = withBit(this.defaults, bit, disposition === 0);
    return E.SUCCESS;
  }

  snapshot(): WasiSignalState {
    return {
      ...(this.callback ? { callback: this.callback } : {}),
      ...(this.hooked ? { hooked: true as const } : {}),
      handlers: this.handlers,
      ignoring: this.ignoring,
      restarting: this.restarting,
      uncaught: this.uncaught,
    };
  }

  restore(state: WasiSignalState): void {
    if (state.callback) this.register(state.callback);
    if (state.hooked) this.hooked = true;
    this.handlers = state.handlers;
    this.ignoring = state.ignoring;
    this.restarting = state.restarting;
    this.uncaught = state.uncaught;
  }

  masks(): { caught: number; ignored: number; restart: number; defaults?: number } | null {
    if (this.hooked) {
      const caught = this.handler() ? this.handlers : 0;
      const defaults = this.defaults;
      this.defaults = 0;
      return { caught, ignored: this.ignoring, restart: this.restarting, defaults };
    }
    if (!this.handler()) return null;
    return { caught: DELIVERED_MASK & ~this.uncaught & ~KERNEL_DEFAULTS, ignored: 0, restart: 0 };
  }

  raise(sig: number): void {
    const handler = this.handler();
    if (!handler) return;
    const outer = { sig: this.delivering, defaulted: this.defaulted, libc: this.libcDefault };
    this.delivering = sig;
    this.defaulted = false;
    this.libcDefault = false;
    try {
      handler(sig);
    } catch (e) {
      const libcExit = e instanceof WasiExit && e.code === LIBC_DEFAULT_EXIT && this.libcDefault;
      if (!(libcExit && !this.defaulted) && !(e instanceof WebAssembly.RuntimeError)) throw e;
      if (!this.defaulted) this.defaultAction(sig);
    } finally {
      this.delivering = outer.sig;
      this.defaulted = outer.defaulted;
      this.libcDefault = outer.libc;
    }
  }

  muted(fd: number, data: Uint8Array): boolean {
    if (fd !== 2 || this.delivering === undefined) return false;
    if (!WASIX_LIBC_DEFAULT_LINE.test(new TextDecoder().decode(data))) return false;
    this.libcDefault = true;
    return true;
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
