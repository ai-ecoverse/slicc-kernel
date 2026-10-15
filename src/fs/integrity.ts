import type { DenialHook } from './dac.ts';
import { isProtected, namesOf } from './protect.ts';
import { fsError, type KernelFs, normalizePath } from './types.ts';

export type IntegrityLookup = (path: string) => string | undefined | Promise<string | undefined>;

export interface IntegrityOptions {
  readonly lookup: IntegrityLookup;
  readonly unknown?: 'allow' | 'deny';
  readonly sources?: readonly string[];
}

export const SOURCE_SUFFIXES: readonly string[] = [
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.py',
  '.pyc',
  '.pth',
  '.zip',
  '.so',
  '.wasm',
  '.sh',
];

const EXEC_OPS = { failed: 'exec-integrity', unknown: 'exec-unverified' } as const;
const READ_OPS = { failed: 'read-integrity', unknown: 'read-unverified' } as const;

type Ops = typeof EXEC_OPS | typeof READ_OPS;

export interface IntegrityCaller {
  pid: number;
  uid: number;
  tag?: string | undefined;
}

interface Checked {
  real: string;
  name: string;
}

export const KERNEL_CALLER: IntegrityCaller = { pid: 0, uid: 0 };

export function integrityOptions(options: IntegrityOptions | undefined): void {
  if (options && typeof options.lookup !== 'function') {
    throw new TypeError('protect.integrity.lookup must be a function');
  }
  integrityUnknown(options);
  integritySources(options);
}

export function integritySources(options: { sources?: unknown } | undefined): readonly string[] {
  const sources = options?.sources ?? SOURCE_SUFFIXES;
  const suffix = (s: unknown) => typeof s === 'string' && /^\.[^/]+$/.test(s);
  if (!Array.isArray(sources) || !sources.every(suffix)) {
    throw new TypeError('protect.integrity.sources must be a list of suffixes such as .js');
  }
  return [...sources];
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
  private readonly unread = new Set<string>();
  private readonly sources: readonly string[];
  private readonly passed = new Set<string>();
  private generation = 0;

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
    this.sources = integritySources(options);
    this.report = report;
  }

  private async real(path: string, asked?: string, known?: string): Promise<Checked | undefined> {
    const at = normalizePath(path);
    const real = known ?? (await this.root.realpath?.(at, true).catch(() => undefined)) ?? at;
    if (isProtected(this.prefixes, real)) return { real, name: real };
    const names = asked === undefined ? [] : await namesOf(this.root, asked);
    if (real !== at) names.push(...(await namesOf(this.root, at)));
    const name = names.findLast((p) => isProtected(this.prefixes, p));
    return name === undefined ? undefined : { real, name };
  }

  async key(path: string, asked?: string): Promise<string | undefined> {
    const found = await this.real(path, asked);
    if (found === undefined) return undefined;
    const { real, name } = found;
    if (name !== real) return `${name}\0${real}\0`;
    if (!this.root.version) return undefined;
    return `${real}\0${await this.root.version(real)}`;
  }

  async read(
    path: string,
    caller: IntegrityCaller,
    plain: () => Promise<Uint8Array>,
    asked?: string
  ): Promise<Uint8Array> {
    return (await this.readKeyed(path, caller, plain, asked)).bytes;
  }

  async readKeyed(
    path: string,
    caller: IntegrityCaller,
    plain: () => Promise<Uint8Array>,
    asked?: string
  ): Promise<{ bytes: Uint8Array; key?: string }> {
    const found = await this.real(path, asked);
    if (found === undefined) return { bytes: await plain() };
    const { real, name } = found;
    const read =
      name !== real
        ? { bytes: await plain(), version: undefined }
        : this.root.readVersioned
          ? await this.root.readVersioned(real)
          : { bytes: await this.root.readFileBuffer(real), version: undefined };
    const { bytes } = read;
    const keyed =
      read.version === undefined ? { bytes } : { bytes, key: `${real}\0${read.version}` };
    await this.verify(name, bytes, caller, EXEC_OPS);
    return keyed;
  }

  get readsChecked(): boolean {
    return this.sources.length > 0;
  }

  async readSource(
    path: string,
    caller: IntegrityCaller,
    plain: () => Promise<Uint8Array>
  ): Promise<Uint8Array> {
    const found = await this.source(path);
    return found === undefined ? plain() : this.checked(found, caller, plain);
  }

  async openSource(path: string, caller: IntegrityCaller, real?: string): Promise<void> {
    const found = await this.source(path, real);
    if (found === undefined) return;
    if (found.name === found.real && this.root.version) {
      if (this.passed.has(`${found.real}\0${await this.root.version(found.real, true)}`)) return;
    }
    await this.checked(found, caller, () => this.root.readFileBuffer(found.real));
  }

  private async checked(
    found: Checked,
    caller: IntegrityCaller,
    plain: () => Promise<Uint8Array>
  ): Promise<Uint8Array> {
    const { real, name } = found;
    if (name !== real || !this.root.readVersioned) {
      const bytes = await plain();
      await this.verify(name, bytes, caller, READ_OPS);
      return bytes;
    }
    const { bytes, version } = await this.root.readVersioned(real, true);
    await this.pass(`${real}\0${version}`, () => this.verify(name, bytes, caller, READ_OPS));
    return bytes;
  }

  private async pass(key: string, check: () => Promise<void>): Promise<void> {
    if (this.passed.has(key)) return;
    const generation = this.generation;
    await check();
    if (generation === this.generation) this.passed.add(key);
  }

  private async source(path: string, known?: string): Promise<Checked | undefined> {
    if (this.sources.length === 0) return undefined;
    const found = await this.real(path, undefined, known);
    if (found === undefined) return undefined;
    const suffixed = (p: string) => this.sources.some((s) => p.endsWith(s));
    if (suffixed(found.real) || suffixed(found.name) || suffixed(normalizePath(path))) return found;
    const st = await this.root.stat(found.real).catch(() => undefined);
    return st?.isFile && ((st.mode ?? 0) & 0o111) !== 0 ? found : undefined;
  }

  private async verify(
    name: string,
    bytes: Uint8Array,
    caller: IntegrityCaller,
    ops: Ops
  ): Promise<void> {
    const actual = await sha256(bytes);
    const denial = { pid: caller.pid, uid: caller.uid, path: name, actual };
    const tagged = caller.tag !== undefined ? { tag: caller.tag } : {};
    let expected: string | undefined;
    try {
      expected = await this.expected(name);
    } catch {
      this.say({ ...denial, ...tagged, op: ops.failed, errno: 'EACCES' });
      throw fsError('EACCES', `integrity lookup failed: ${name}`);
    }
    if (expected === actual) return;
    if (expected === undefined && this.unknown === 'allow') {
      const seen = ops === EXEC_OPS ? this.unverified : this.unread;
      if (!seen.has(name)) {
        seen.add(name);
        this.say({ ...denial, ...tagged, op: ops.unknown, errno: 'ENODATA' });
      }
      return;
    }
    const known = expected !== undefined ? { expected } : {};
    this.say({ ...denial, ...tagged, ...known, op: ops.failed, errno: 'EACCES' });
    throw fsError('EACCES', `integrity check failed: ${name}`);
  }

  forget(path?: string): void {
    this.generation++;
    for (const seen of [this.unverified, this.unread]) {
      for (const name of [...seen]) {
        if (path === undefined || isProtected([path], name)) seen.delete(name);
      }
    }
    for (const key of [...this.passed]) {
      if (path === undefined || isProtected([path], key.slice(0, key.indexOf('\0')))) {
        this.passed.delete(key);
      }
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
