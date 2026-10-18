import type { Cred } from '../../kernel/cred.ts';
import { CRED_GEN, UMASK } from './wasi-files.ts';

export class CredCache {
  private cred: Cred | undefined;
  private stamp = 0;
  private readonly fetch: () => Cred;
  private readonly shared: Int32Array | undefined;

  constructor(fetch: () => Cred, shared?: Int32Array) {
    this.fetch = fetch;
    this.shared = shared;
  }

  private gen(): number {
    return this.shared ? Atomics.load(this.shared, CRED_GEN) : 0;
  }

  get(): Cred {
    const gen = this.gen();
    if (this.cred === undefined || this.stamp !== gen) {
      this.cred = this.fetch();
      this.stamp = gen;
    }
    return this.cred;
  }

  change(apply: () => Cred): Cred {
    const seen = this.gen();
    const cred = apply();
    if (!this.shared) {
      this.cred = cred;
      return cred;
    }
    const was = Atomics.add(this.shared, CRED_GEN, 1);
    this.cred = was === seen ? cred : undefined;
    this.stamp = was + 1;
    return cred;
  }
}

const KNOWN = 0x10000;
const LOCKED = 0x20000;

export class UmaskCache {
  private mask: number | undefined;
  private readonly call: (mask?: number) => number;
  private readonly shared: Int32Array | undefined;

  constructor(call: (mask?: number) => number, shared?: Int32Array) {
    this.call = call;
    this.shared = shared;
  }

  get(): number {
    const { shared } = this;
    if (!shared) {
      this.mask ??= this.call();
      return this.mask;
    }
    for (;;) {
      const seen = Atomics.load(shared, UMASK);
      if (seen & LOCKED) Atomics.wait(shared, UMASK, seen);
      else if (seen & KNOWN) return seen & 0o777;
      else {
        const mask = this.call();
        if (Atomics.compareExchange(shared, UMASK, 0, mask | KNOWN) === 0) return mask;
      }
    }
  }

  set(mask: number): number {
    const { shared } = this;
    if (!shared) {
      const old = this.call(mask);
      this.mask = mask & 0o777;
      return old;
    }
    const seen = this.lock(shared);
    let next = seen;
    try {
      const old = this.call(mask);
      next = (mask & 0o777) | KNOWN;
      return old;
    } finally {
      Atomics.store(shared, UMASK, next);
      Atomics.notify(shared, UMASK);
    }
  }

  private lock(shared: Int32Array): number {
    for (;;) {
      const seen = Atomics.load(shared, UMASK);
      if (seen & LOCKED) Atomics.wait(shared, UMASK, seen);
      else if (Atomics.compareExchange(shared, UMASK, seen, seen | LOCKED) === seen) return seen;
    }
  }
}
