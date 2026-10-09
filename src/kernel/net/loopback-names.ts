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
