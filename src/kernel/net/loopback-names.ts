export const HOST_LOOPBACK = 'host.slicc.internal';

export const HOST_LOOPBACK_ADDRESS = [10, 0, 2, 2] as const;

export const PAGE_LOOPBACK = 'kernel.localhost';

export const PAGE_LOOPBACK_URL = `http://{port}.${PAGE_LOOPBACK}`;

export function toHostLoopback(href: string): string {
  const url = new URL(href);
  if (url.hostname.replace(/\.$/, '').toLowerCase() !== HOST_LOOPBACK) return href;
  url.hostname = '127.0.0.1';
  return url.href;
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const LOOPBACK_V6 = new Set(['::1', '::', '0:0:0:0:0:0:0:1']);
const MAPPED_V4 = /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/;
const KERNEL_PORT = /^(\d{1,5})\.kernel\.localhost$/;
const SCHEMES: Readonly<Record<string, number>> = {
  'http:': 80,
  'ws:': 80,
  'https:': 443,
  'wss:': 443,
};

export function isKernelLoopbackHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    LOOPBACK_V4.test(host) ||
    LOOPBACK_V6.has(host) ||
    MAPPED_V4.test(host)
  );
}

export function kernelLoopbackPort(href: string): number | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  const fallback = SCHEMES[url.protocol];
  if (fallback === undefined || !isKernelLoopbackHost(url.hostname)) return undefined;
  const named = KERNEL_PORT.exec(url.hostname.replace(/\.$/, '').toLowerCase())?.[1];
  const port = Number(named ?? (url.port || fallback));
  return port >= 1 && port <= 65535 ? port : undefined;
}

export const DEFAULT_HOSTNAME = 'slicc';

export const HOSTNAME_ADDRESS = '127.0.1.1';

export const LIBC_HOSTNAMES: readonly string[] = ['emscripten', 'wasmer.sh'];

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function reserved(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower === HOST_LOOPBACK ||
    lower === 'wasmer.sh' ||
    /^\d+(\.\d+){3}$/.test(lower)
  );
}

export function isHostname(name: unknown): name is string {
  if (typeof name !== 'string' || name.length > 253 || reserved(name)) return false;
  return name.split('.').every((l) => LABEL.test(l));
}

export function hostnameOf(env: Readonly<Record<string, string>>): string {
  return isHostname(env.HOSTNAME) ? env.HOSTNAME : DEFAULT_HOSTNAME;
}

export function ownNames(hostname: string): string[] {
  return [...new Set([hostname.toLowerCase(), ...LIBC_HOSTNAMES])];
}

export function hostsFile(hostname: string = DEFAULT_HOSTNAME): string {
  return [
    '127.0.0.1 localhost localhost.localdomain',
    '::1 localhost ip6-localhost',
    `${HOSTNAME_ADDRESS} ${ownNames(hostname).join(' ')}`,
    `${HOST_LOOPBACK_ADDRESS.join('.')} ${HOST_LOOPBACK}`,
    '',
  ].join('\n');
}
