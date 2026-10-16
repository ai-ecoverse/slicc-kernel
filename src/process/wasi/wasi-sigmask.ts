import { SIG, sigbit } from '../../kernel/signals.ts';
import {
  type BlockedMask,
  SAB_I_BLOCKED,
  SAB_I_BLOCKED_HI,
  SAB_I_KILLED,
  SAB_I_SIGNALS,
  SAB_I_STOP,
  storeBlocked,
} from '../../realm/sync-sab-wire.ts';
import { E } from './wasi-abi.ts';

const UNBLOCKABLE = sigbit(SIG.KILL) | sigbit(SIG.STOP);
const LIBC_UNBLOCKABLE = (1 << (SIG.KILL - 1)) | (1 << (SIG.STOP - 1));

const FOREVER = 0xffff_ffff_ffff_ffffn;
const NS_PER_MS = 1_000_000n;
const POLL_MS = 50;

const SIG_BLOCK = 0;
const SIG_UNBLOCK = 1;
const SIG_SETMASK = 2;

export const kernelBits = (lo: number): number => (lo << 1) & ~UNBLOCKABLE;

export const libcBits = (bits: number): number => (bits >>> 1) & ~LIBC_UNBLOCKABLE;

const apply = (how: number, mask: number, set: number): number => {
  if (how === SIG_BLOCK) return mask | set;
  if (how === SIG_UNBLOCK) return mask & ~set;
  return set;
};

export class WasiSigmask {
  private lo: number;
  private hi: number;
  private readonly header: Int32Array;
  private readonly deliver: () => void;
  private readonly process: Int32Array | undefined;
  readonly tid: number;
  constructor(header: Int32Array, deliver: () => void, process?: Int32Array, tid = 1) {
    this.header = header;
    this.deliver = deliver;
    this.process = process;
    this.tid = tid;
    this.lo = libcBits(Atomics.load(header, SAB_I_BLOCKED));
    this.hi = Atomics.load(header, SAB_I_BLOCKED_HI);
  }

  static unsupported(header: Int32Array): void {
    storeBlocked(header, [0, 0]);
  }

  set(how: number, setLo: number, setHi: number, old: (lo: number, hi: number) => void): number {
    if (how !== SIG_BLOCK && how !== SIG_UNBLOCK && how !== SIG_SETMASK) return E.INVAL;
    old(this.lo >>> 0, this.hi >>> 0);
    this.lo = apply(how, this.lo, setLo | 0) & ~LIBC_UNBLOCKABLE;
    this.hi = apply(how, this.hi, setHi | 0);
    const now = kernelBits(this.lo);
    storeBlocked(this.header, [now, this.hi]);
    if ((Atomics.load(this.header, SAB_I_SIGNALS) & ~now) !== 0) this.deliver();
    return E.SUCCESS;
  }

  swap(setLo: number, setHi: number): [number, number] {
    const old: [number, number] = [this.lo, this.hi];
    this.lo = setLo & ~LIBC_UNBLOCKABLE;
    this.hi = setHi | 0;
    storeBlocked(this.header, [kernelBits(this.lo), this.hi]);
    return old;
  }

  deliverUnblocked(): boolean {
    const now = Atomics.load(this.header, SAB_I_BLOCKED);
    if ((Atomics.load(this.header, SAB_I_SIGNALS) & ~now) === 0) return false;
    this.deliver();
    return true;
  }

  restore([lo, hi]: [number, number]): void {
    this.set(SIG_SETMASK, lo, hi, () => {});
  }

  blockedBits(): number {
    return Atomics.load(this.header, SAB_I_BLOCKED);
  }

  blocks(sig: number): boolean {
    return (Atomics.load(this.header, SAB_I_BLOCKED) & sigbit(sig)) !== 0;
  }

  inherited(): BlockedMask {
    return [kernelBits(this.lo), this.hi];
  }

  discard(sig: number): void {
    Atomics.and(this.header, SAB_I_SIGNALS, ~sigbit(sig));
    if (this.process) Atomics.and(this.process, SAB_I_SIGNALS, ~sigbit(sig));
  }

  sigwait(
    setLo: number,
    timeoutNs: bigint,
    publish: (set: number) => void,
    took: (sig: number) => void,
    entered = false
  ): number {
    const set = kernelBits(setLo | 0);
    const value = BigInt.asUintN(64, timeoutNs);
    const deadline =
      value === FOREVER
        ? Number.POSITIVE_INFINITY
        : performance.now() + Number((value + NS_PER_MS - 1n) / NS_PER_MS);
    publish(set);
    try {
      for (;;) {
        const seen = Atomics.load(this.header, SAB_I_SIGNALS);
        const sig = this.take(set);
        if (sig !== 0) {
          took(sig);
          return E.SUCCESS;
        }
        if (entered || this.deliverUnblocked() || this.interrupted()) return E.INTR;
        const left = deadline - performance.now();
        if (left <= 0) return E.AGAIN;
        Atomics.wait(this.header, SAB_I_SIGNALS, seen, Math.min(left, POLL_MS));
      }
    } finally {
      publish(0);
    }
  }

  private take(set: number): number {
    for (const header of this.process ? [this.header, this.process] : [this.header]) {
      const ready = Atomics.load(header, SAB_I_SIGNALS) & set;
      if (ready === 0) continue;
      const bit = ready & -ready;
      if ((Atomics.and(header, SAB_I_SIGNALS, ~bit) & bit) !== 0) return 31 - Math.clz32(bit);
    }
    return 0;
  }

  private interrupted(): boolean {
    const killed = this.process ?? this.header;
    if (Atomics.load(killed, SAB_I_KILLED) !== 0) {
      this.deliver();
      return true;
    }
    if (Atomics.load(killed, SAB_I_STOP) !== 1) return false;
    while (Atomics.load(killed, SAB_I_STOP) === 1) Atomics.wait(killed, SAB_I_STOP, 1);
    return true;
  }

  pending(): number {
    const own = Atomics.load(this.header, SAB_I_SIGNALS);
    return libcBits(own | (this.process ? Atomics.load(this.process, SAB_I_SIGNALS) : 0));
  }
}
