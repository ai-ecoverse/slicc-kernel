import type { DenialHook } from './dac.ts';
import { isProtected } from './protect.ts';
import { fsError, type KernelFs, normalizePath } from './types.ts';

export type IntegrityLookup = (path: string) => string | undefined | Promise<string | undefined>;

export interface IntegrityOptions {
  readonly lookup: IntegrityLookup;
  readonly unknown?: 'allow' | 'deny';
}

export interface IntegrityCaller {
  pid: number;
  uid: number;
  tag?: string | undefined;
}

export const KERNEL_CALLER: IntegrityCaller = { pid: 0, uid: 0 };

export function integrityOptions(options: IntegrityOptions | undefined): void {
  if (options && typeof options.lookup !== 'function') {
    throw new TypeError('protect.integrity.lookup must be a function');
  }
  integrityUnknown(options);
}

export function integrityUnknown(options: { unknown?: string } | undefined): 'allow' | 'deny' {
  const unknown = options?.unknown ?? 'allow';
  if (unknown !== 'allow' && unknown !== 'deny') {
    throw new TypeError("protect.integrity.unknown must be 'allow' or 'deny'");
  }
  return unknown;
}

function hex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

export class Integrity {
  private readonly prefixes: readonly string[];
  private readonly root: KernelFs;
  private readonly lookup: IntegrityLookup;
  private readonly unknown: 'allow' | 'deny';
  private readonly report: DenialHook;
  private readonly unverified = new Set<string>();

  constructor(
    prefixes: readonly string[],
    root: KernelFs,
    options: IntegrityOptions,
    report: DenialHook
  ) {
    this.prefixes = prefixes;
    this.root = root;
    this.lookup = options.lookup;
    this.unknown = integrityUnknown(options);
    this.report = report;
  }

  private async real(path: string): Promise<string | undefined> {
    const at = normalizePath(path);
    const real = (await this.root.realpath?.(at, true).catch(() => undefined)) ?? at;
    return isProtected(this.prefixes, real) ? real : undefined;
  }

  async key(path: string): Promise<string | undefined> {
    const real = await this.real(path);
    if (real === undefined || !this.root.version) return undefined;
    return `${real}\0${await this.root.version(real)}`;
  }

  async read(
    path: string,
    caller: IntegrityCaller,
    plain: () => Promise<Uint8Array>
  ): Promise<Uint8Array> {
    return (await this.readKeyed(path, caller, plain)).bytes;
  }

  async readKeyed(
    path: string,
    caller: IntegrityCaller,
    plain: () => Promise<Uint8Array>
  ): Promise<{ bytes: Uint8Array; key?: string }> {
    const real = await this.real(path);
    if (real === undefined) return { bytes: await plain() };
    const read = this.root.readVersioned
      ? await this.root.readVersioned(real)
      : { bytes: await this.root.readFileBuffer(real), version: undefined };
    const { bytes } = read;
    const keyed =
      read.version === undefined ? { bytes } : { bytes, key: `${real}\0${read.version}` };
    const actual = await sha256(bytes);
    const denial = { pid: caller.pid, uid: caller.uid, path: real, actual };
    const tagged = caller.tag !== undefined ? { tag: caller.tag } : {};
    let expected: string | undefined;
    try {
      expected = await this.expected(real);
    } catch {
      this.say({ ...denial, ...tagged, op: 'exec-integrity', errno: 'EACCES' });
      throw fsError('EACCES', `integrity lookup failed: ${real}`);
    }
    if (expected === undefined) {
      if (this.unknown === 'allow') {
        if (!this.unverified.has(real)) {
          this.unverified.add(real);
          this.say({ ...denial, ...tagged, op: 'exec-unverified', errno: 'ENODATA' });
        }
        return keyed;
      }
    } else if (expected === actual) {
      return keyed;
    }
    const known = expected !== undefined ? { expected } : {};
    this.say({ ...denial, ...tagged, ...known, op: 'exec-integrity', errno: 'EACCES' });
    throw fsError('EACCES', `integrity check failed: ${real}`);
  }

  forget(path?: string): void {
    for (const name of [...this.unverified]) {
      if (path === undefined || isProtected([path], name)) this.unverified.delete(name);
    }
  }

  private async expected(path: string): Promise<string | undefined> {
    const answer = await this.lookup(path);
    return typeof answer === 'string' ? answer.toLowerCase() : undefined;
  }

  private say(event: Parameters<DenialHook>[0]): void {
    try {
      this.report(event);
    } catch {}
  }
}
