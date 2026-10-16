import type { KernelFs } from '../../fs/types.ts';
import { ipv4Bytes, ipv6Groups } from './routes.ts';

export type HostsTable = ReadonlyMap<string, readonly string[]>;

export const HOSTS_PATH = '/etc/hosts';

export function parseHosts(text: string): HostsTable {
  const table = new Map<string, string[]>();
  for (const raw of text.split('\n')) {
    const [address, ...names] = raw.replace(/#.*/, '').trim().split(/\s+/);
    if (!address || names.length === 0) continue;
    if (ipv4Bytes(address) === undefined && ipv6Groups(address) === undefined) continue;
    for (const name of names) {
      const key = name.toLowerCase().replace(/\.$/, '');
      const known = table.get(key) ?? [];
      if (!known.includes(address)) known.push(address);
      table.set(key, known);
    }
  }
  return table;
}

export function hostsReader(
  fs: Pick<KernelFs, 'stat' | 'readFile'>,
  path = HOSTS_PATH
): () => Promise<HostsTable | undefined> {
  let stamp = '';
  let table: HostsTable | undefined;
  return async () => {
    const st = await fs.stat(path).catch(() => undefined);
    if (!st?.isFile) {
      stamp = '';
      table = undefined;
      return undefined;
    }
    const now = `${st.ino}:${st.size}:${st.mtime.getTime()}`;
    if (now === stamp && table) return table;
    const text = await fs.readFile(path).catch(() => undefined);
    if (text === undefined) return undefined;
    stamp = now;
    table = parseHosts(text);
    return table;
  };
}
