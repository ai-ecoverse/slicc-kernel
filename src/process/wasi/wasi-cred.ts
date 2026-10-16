import type { Cred } from '../../kernel/cred.ts';
import { CRED_GEN } from './wasi-files.ts';

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
