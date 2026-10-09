import { KernelPipe } from '../pipe.ts';
import type { UplinkConn } from './uplink.ts';

const CHUNK = 64 * 1024;

export interface UplinkLink {
  rx: KernelPipe;
  tx: KernelPipe;
}

export function hostPort(text: string): { host: string; port: number } | undefined {
  const match = /^\[?([^\]]*?)\]?:(\d{1,5})$/.exec(text);
  const port = Number(match?.[2]);
  const host = match?.[1];
  if (!host || port > 65535) return undefined;
  return { host, port };
}

async function inbound(conn: UplinkConn, rx: KernelPipe): Promise<void> {
  for (;;) {
    while (!rx.writeReady) await rx.changed();
    if (rx.readersGone) return;
    const bytes = await conn.read();
    if (!bytes) return;
    await rx.write(bytes);
  }
}

async function outbound(conn: UplinkConn, tx: KernelPipe): Promise<void> {
  for (;;) {
    const bytes = await tx.read(CHUNK);
    if (bytes.length === 0) {
      conn.closeWrite();
      return;
    }
    for (let at = 0; at < bytes.length; ) {
      const n = await conn.write(bytes.subarray(at));
      if (!(n > 0)) throw new Error('the uplink wrote nothing');
      at += n;
    }
  }
}

async function released(rx: KernelPipe, tx: KernelPipe): Promise<void> {
  while (!(rx.readersGone && tx.writersGone)) await Promise.race([rx.changed(), tx.changed()]);
}

export function uplinkLink(conn: UplinkConn, onReset: () => void): UplinkLink {
  const rx = new KernelPipe();
  const tx = new KernelPipe();
  for (const pipe of [rx, tx]) {
    pipe.openRead();
    pipe.openWrite();
  }
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    conn.close();
  };
  void inbound(conn, rx)
    .catch(() => {
      onReset();
      close();
      tx.closeRead();
    })
    .finally(() => rx.closeWrite());
  void outbound(conn, tx)
    .catch(close)
    .finally(() => tx.closeRead());
  void released(rx, tx).then(close);
  return { rx, tx };
}
