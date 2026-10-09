export const HOST_LOOPBACK = 'host.slicc.internal';

export const HOST_LOOPBACK_ADDRESS = [10, 0, 2, 2] as const;

export const CDP_LOOPBACK = 'cdp.slicc.internal';

export const PAGE_LOOPBACK = 'kernel.localhost';

export const PAGE_LOOPBACK_URL = `http://{port}.${PAGE_LOOPBACK}`;

export function toHostLoopback(href: string): string {
  const url = new URL(href);
  if (url.hostname.replace(/\.$/, '').toLowerCase() !== HOST_LOOPBACK) return href;
  url.hostname = '127.0.0.1';
  return url.href;
}

export function hostsFile(): string {
  return `127.0.0.1 localhost\n::1 localhost ip6-localhost\n${HOST_LOOPBACK_ADDRESS.join('.')} ${HOST_LOOPBACK}\n127.0.0.1 ${CDP_LOOPBACK}\n`;
}
