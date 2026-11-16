import { KernelError } from '../fd-table.ts';
import { type DnsForward, forwardedLookup } from './dns-stub.ts';
import { type HostsTable, parseHosts } from './hosts-file.ts';
import {
  DEFAULT_HOSTNAME,
  HOST_LOOPBACK,
  HOST_LOOPBACK_ADDRESS,
  HOSTNAME_ADDRESS,
  hostsFile,
  ownNames,
} from './loopback-names.ts';
import { ipv4Bytes, ipv6Groups, type Routes } from './routes.ts';
import { answerOf, type NetworkUplink, type ResolveAnswer, type ResolveFamily } from './uplink.ts';

export const RESOLVE_TTL_MAX = 60;
export const RESOLVE_TIMEOUT_MS = 10_000;
export const RESOLVE_CACHE_MAX = 256;

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', '::1']);

interface Cached {
  addresses: string[];
  expires: number;
}

export interface ResolverOptions {
  uplink?: NetworkUplink | undefined;
  routes: Routes;
  now?: () => number;
  timeoutMs?: number;
  log?: (message: string) => void;
  hostname?: string;
  hosts?: () => Promise<HostsTable | undefined>;
  forward?: DnsForward | undefined;
}

function loopbackName(name: string, own: readonly string[]): boolean {
  return LOOPBACK_NAMES.has(name) || name.endsWith('.localhost') || own.includes(name);
}

export function hostsEntry(
  name: string,
  own: readonly string[] = ownNames(DEFAULT_HOSTNAME)
): string | undefined {
  if (own.includes(name)) return HOSTNAME_ADDRESS;
  if (LOOPBACK_NAMES.has(name) || name.endsWith('.localhost')) return '127.0.0.1';
  if (name === HOST_LOOPBACK) return HOST_LOOPBACK_ADDRESS.join('.');
  return ipv4Bytes(name) ? name : undefined;
}

export class Resolver {
  private readonly uplink: NetworkUplink | undefined;
  private readonly routes: Routes;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly own: readonly string[];
  private readonly builtin: HostsTable;
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Lookup>();
  private readonly hosts: (() => Promise<HostsTable | undefined>) | undefined;
  private readonly forward: DnsForward | undefined;

  constructor(options: ResolverOptions) {
    this.uplink = options.uplink;
    this.routes = options.routes;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? RESOLVE_TIMEOUT_MS;
    this.log = options.log ?? ((message) => console.warn(message));
    this.own = ownNames(options.hostname ?? DEFAULT_HOSTNAME);
    this.builtin = parseHosts(hostsFile(options.hostname ?? DEFAULT_HOSTNAME));
    this.hosts = options.hosts;
    this.forward = options.forward;
  }

  private async fromFile(key: string, family: ResolveFamily): Promise<string[] | undefined> {
    const listed = (await this.hosts?.().catch(() => undefined))?.get(key);
    if (!listed) return undefined;
    const v4 = listed.filter((a) => ipv4Bytes(a) !== undefined);
    const v6 = listed.filter((a) => ipv4Bytes(a) === undefined);
    return family === 4 ? v4 : family === 6 ? v6 : [...v4, ...v6];
  }

  async known(name: string): Promise<boolean> {
    const key = name.toLowerCase().replace(/\.$/, '');
    if (ipv4Bytes(key) || ipv6Groups(key)) return false;
    if (hostsEntry(key, this.own) !== undefined) return true;
    return ((await this.hosts?.().catch(() => undefined))?.get(key)?.length ?? 0) > 0;
  }

  async reverse(address: string): Promise<string | undefined> {
    const v6 = ipv6Groups(address)?.join(':');
    const same = (a: string) =>
      a === address || (v6 !== undefined && ipv6Groups(a)?.join(':') === v6);
    const file = await this.hosts?.().catch(() => undefined);
    for (const table of [file, this.builtin]) {
      for (const [name, addresses] of table ?? []) if (addresses.some(same)) return name;
    }
    if (ipv4Bytes(address)?.[0] === 127) return 'localhost';
    return undefined;
  }

  async resolve(
    name: string,
    family: ResolveFamily,
    blocking?: () => AbortSignal,
    forwarded = true
  ): Promise<string[]> {
    const key = name.toLowerCase().replace(/\.$/, '');
    const local = hostsEntry(key, this.own);
    if (ipv6Groups(key)) {
      const v4 = family !== 6 && local ? [local] : [];
      return family === 4 ? v4 : [...v4, key];
    }
    const listed = this.hosts ? await this.fromFile(key, family) : undefined;
    if (listed?.length) return listed;
    if (local) {
      const six = loopbackName(key, this.own) ? ['::1'] : [];
      return family === 6 ? six : family === 4 ? [local] : [local, ...six];
    }
    if (!this.uplink || key === '') return [];
    const asked: ResolveFamily = this.uplink.traits.ipv6 ? family : 4;
    if (family === 6 && asked !== 6) return [];
    return this.remote(key, asked, blocking, forwarded);
  }

  private remote(
    key: string,
    asked: ResolveFamily,
    blocking: (() => AbortSignal) | undefined,
    forwarded: boolean
  ): Promise<string[]> {
    const id = `${forwarded && this.forward ? 'forwarded' : 'uplink'}:${asked}:${key}`;
    const hit = this.cache.get(id);
    if (hit && hit.expires > this.now()) return Promise.resolve(hit.addresses);
    const signal = blocking?.();
    if (signal?.aborted) return Promise.reject(new KernelError('EINTR'));
    let lookup = this.pending.get(id);
    if (!lookup) {
      const abort = new AbortController();
      const work = this.lookup(key, asked, id, abort.signal, forwarded);
      lookup = { work, abort, waiters: 0 };
      this.pending.set(id, lookup);
      const done = () => this.pending.delete(id);
      void lookup.work.then(done, done);
    }
    return waitFor(lookup, signal);
  }

  private async lookup(
    name: string,
    family: ResolveFamily,
    id: string,
    abandoned: AbortSignal,
    forwarded: boolean
  ): Promise<string[]> {
    const timeout = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), abandoned]);
    const own = await this.ask(name, `resolve ${name}: the uplink gave no answer`, timeout, () =>
      this.uplink?.resolve ? this.uplink.resolve(name, family, timeout) : Promise.resolve([])
    );
    let answer = { ...own, addresses: own.addresses.filter((a) => this.usable(name, a, family)) };
    const forward = this.forward;
    if (answer.addresses.length === 0 && forwarded && forward) {
      const found = await this.ask(
        name,
        `resolve ${name}: the DNS forwarder gave no answer`,
        timeout,
        () => forwardedLookup(forward, name, family, timeout)
      );
      answer = { ...found, addresses: found.addresses.filter((a) => this.usable(name, a, family)) };
    }
    if (answer.addresses.length > 0) this.remember(id, answer.addresses, answer.ttl);
    return answer.addresses;
  }

  private async ask(
    name: string,
    failure: string,
    timeout: AbortSignal,
    work: () => Promise<string[] | ResolveAnswer>
  ): Promise<ResolveAnswer> {
    try {
      return answerOf(
        await Promise.race([
          work(),
          new Promise<never>((_, reject) =>
            timeout.addEventListener('abort', () => reject(timeout.reason), { once: true })
          ),
        ])
      );
    } catch {
      throw new KernelError('ETIMEDOUT', failure);
    }
  }

  private usable(name: string, address: string, family: ResolveFamily): boolean {
    const v4 = ipv4Bytes(address) !== undefined;
    if (!v4 && (family === 4 || !ipv6Groups(address))) return false;
    if (v4 && family === 6) return false;
    const kind = this.routes.classify(address);
    if (kind !== 'loopback' && kind !== 'host' && kind !== 'reserved') return true;
    this.log(`slicc-kernel: dropped the uplink's answer ${address} for ${name}: it is ${kind}`);
    return false;
  }

  private remember(id: string, addresses: string[], ttl: number | undefined): void {
    const seconds = Math.min(ttl ?? RESOLVE_TTL_MAX, RESOLVE_TTL_MAX);
    if (seconds <= 0) return;
    this.cache.delete(id);
    this.cache.set(id, { addresses, expires: this.now() + seconds * 1000 });
    if (this.cache.size > RESOLVE_CACHE_MAX) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
  }
}

interface Lookup {
  work: Promise<string[]>;
  abort: AbortController;
  waiters: number;
}

function waitFor(lookup: Lookup, signal: AbortSignal | undefined): Promise<string[]> {
  lookup.waiters++;
  return new Promise<string[]>((resolve, reject) => {
    const abort = () => {
      if (--lookup.waiters === 0) lookup.abort.abort(new KernelError('EINTR'));
      reject(new KernelError('EINTR'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    const settle = (finish: () => void) => {
      if (signal?.aborted) return;
      lookup.waiters--;
      signal?.removeEventListener('abort', abort);
      finish();
    };
    void lookup.work.then(
      (value) => settle(() => resolve(value)),
      (err: unknown) => settle(() => reject(err))
    );
  });
}
