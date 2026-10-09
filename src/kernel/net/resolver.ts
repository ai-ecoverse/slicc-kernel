import { KernelError } from '../fd-table.ts';
import { HOST_LOOPBACK, HOST_LOOPBACK_ADDRESS } from './loopback-names.ts';
import { ipv4Bytes, ipv6Groups, type NetworkLabel, type Routes } from './routes.ts';
import { answerOf, type NetworkUplink, type ResolveFamily } from './uplink.ts';

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
}

export function hostsEntry(name: string): string | undefined {
  if (LOOPBACK_NAMES.has(name) || name.endsWith('.localhost')) return '127.0.0.1';
  if (name === HOST_LOOPBACK) return HOST_LOOPBACK_ADDRESS.join('.');
  return ipv4Bytes(name) ? name : undefined;
}

export class Resolver {
  private readonly uplink: NetworkUplink | undefined;
  private readonly routes: Routes;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Lookup>();

  constructor(options: ResolverOptions) {
    this.uplink = options.uplink;
    this.routes = options.routes;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? RESOLVE_TIMEOUT_MS;
  }

  async resolve(
    name: string,
    family: ResolveFamily,
    label: NetworkLabel,
    blocking?: () => AbortSignal
  ): Promise<string[]> {
    const key = name.toLowerCase().replace(/\.$/, '');
    const local = hostsEntry(key);
    if (ipv6Groups(key)) {
      const v4 = family !== 6 && local ? [local] : [];
      return family === 4 ? v4 : [...v4, key];
    }
    if (local) return family === 6 ? [] : [local];
    if (label !== 'uplink' || !this.uplink || key === '') return [];
    const asked: ResolveFamily = this.uplink.traits.ipv6 ? family : 4;
    if (family === 6 && asked !== 6) return [];
    const id = `${asked}:${key}`;
    const hit = this.cache.get(id);
    if (hit && hit.expires > this.now()) return hit.addresses;
    let lookup = this.pending.get(id);
    if (!lookup) {
      const abort = new AbortController();
      lookup = { work: this.lookup(key, asked, id, abort.signal), abort, waiters: 0 };
      this.pending.set(id, lookup);
      void lookup.work.then(() => this.pending.delete(id));
    }
    return waitFor(lookup, blocking?.());
  }

  private async lookup(
    name: string,
    family: ResolveFamily,
    id: string,
    abandoned: AbortSignal
  ): Promise<string[]> {
    const uplink = this.uplink as NetworkUplink;
    const timeout = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), abandoned]);
    let answer: { addresses: string[]; ttl?: number };
    try {
      answer = answerOf(
        await Promise.race([
          uplink.resolve(name, family, timeout),
          new Promise<never>((_, reject) =>
            timeout.addEventListener('abort', () => reject(timeout.reason), { once: true })
          ),
        ])
      );
    } catch {
      return [];
    }
    const addresses = answer.addresses.filter((a) => this.usable(a, family));
    if (addresses.length > 0) this.remember(id, addresses, answer.ttl);
    return addresses;
  }

  private usable(address: string, family: ResolveFamily): boolean {
    const v4 = ipv4Bytes(address) !== undefined;
    if (!v4 && (family === 4 || !ipv6Groups(address))) return false;
    if (v4 && family === 6) return false;
    const kind = this.routes.classify(address);
    return kind !== 'loopback' && kind !== 'host' && kind !== 'reserved';
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
  if (signal?.aborted) return Promise.reject(new KernelError('EINTR'));
  lookup.waiters++;
  return new Promise<string[]>((resolve, reject) => {
    const abort = () => {
      if (--lookup.waiters === 0) lookup.abort.abort(new KernelError('EINTR'));
      reject(new KernelError('EINTR'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    void lookup.work.then((value) => {
      if (signal?.aborted) return;
      lookup.waiters--;
      signal?.removeEventListener('abort', abort);
      resolve(value);
    });
  });
}
