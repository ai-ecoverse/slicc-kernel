import { SIG, sigbit } from '../../kernel/signals.ts';
import {
  type BlockedMask,
  SAB_I_BLOCKED,
  SAB_I_BLOCKED_HI,
  SAB_I_SIGNALS,
  storeBlocked,
} from '../../realm/sync-sab-wire.ts';
import { E } from './wasi-abi.ts';

const UNBLOCKABLE = sigbit(SIG.KILL) | sigbit(SIG.STOP);
const LIBC_UNBLOCKABLE = (1 << (SIG.KILL - 1)) | (1 << (SIG.STOP - 1));

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
  constructor(header: Int32Array, deliver: () => void, process?: Int32Array) {
    this.header = header;
    this.deliver = deliver;
    this.process = process;
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

  inherited(): BlockedMask {
    return [kernelBits(this.lo), this.hi];
  }

  discard(sig: number): void {
    Atomics.and(this.header, SAB_I_SIGNALS, ~sigbit(sig));
    if (this.process) Atomics.and(this.process, SAB_I_SIGNALS, ~sigbit(sig));
  }

  pending(): number {
    const own = Atomics.load(this.header, SAB_I_SIGNALS);
    return libcBits(own | (this.process ? Atomics.load(this.process, SAB_I_SIGNALS) : 0));
  }
}
