import { spkiOf } from './tls-chain.ts';
import type { TlsEngine } from './tls-engine.ts';

export const ANCHORS_MAX = 64;
export const ANCHOR_BYTES_MAX = 8 * 1024;

const NOT_TRUSTED = 0x08;
const PIN = /^[A-Za-z0-9+/]{43}=$/;

export interface Anchors {
  anchors: Uint8Array[];
  pins: string[];
}

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function der(text: unknown): Uint8Array | undefined {
  if (typeof text !== 'string' || text.length === 0 || text.length > (ANCHOR_BYTES_MAX * 4) / 3 + 4)
    return undefined;
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export function anchorsOf(reply: unknown): Anchors | undefined {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) return undefined;
  const r = reply as { error?: unknown; anchors?: unknown; pins?: unknown };
  if (r.error !== undefined || !Array.isArray(r.anchors) || !Array.isArray(r.pins))
    return undefined;
  if (r.anchors.length + r.pins.length > ANCHORS_MAX) return undefined;
  const anchors = r.anchors.map(der);
  if (anchors.some((a) => a === undefined)) return undefined;
  if (!r.pins.every((p) => typeof p === 'string' && PIN.test(p))) return undefined;
  return { anchors: anchors as Uint8Array[], pins: r.pins as string[] };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return b64(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  );
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function flagsWith(
  engine: TlsEngine,
  anchor: Uint8Array | undefined,
  chain: readonly Uint8Array[],
  host: string
): number | undefined {
  const store = engine.store();
  try {
    if (anchor) store.add(anchor);
    return engine.chainFlags(store, chain, host);
  } catch {
    return undefined;
  } finally {
    store.release();
  }
}

function leafPinned(engine: TlsEngine, leaf: Uint8Array, host: string): boolean {
  const flags = flagsWith(engine, undefined, [leaf], host);
  return flags !== undefined && (flags & ~NOT_TRUSTED) === 0;
}

function issuedBy(
  engine: TlsEngine,
  anchor: Uint8Array,
  chain: readonly Uint8Array[],
  host: string
) {
  return flagsWith(engine, anchor, chain, host) === 0;
}

export async function anchorFor(
  engine: TlsEngine,
  chain: readonly Uint8Array[],
  host: string,
  found: Anchors
): Promise<string | undefined> {
  const leaf = chain[0];
  if (!leaf || !engine.chainVerify) return undefined;
  for (const anchor of found.anchors) {
    const ok = same(anchor, leaf)
      ? leafPinned(engine, leaf, host)
      : issuedBy(engine, anchor, chain, host);
    if (ok) return sha256(anchor);
  }
  for (const [i, cert] of chain.entries()) {
    const spki = spkiOf(cert);
    if (!spki || !found.pins.includes(await sha256(spki))) continue;
    const ok = i === 0 ? leafPinned(engine, leaf, host) : issuedBy(engine, cert, chain, host);
    if (ok) return sha256(spki);
  }
  return undefined;
}
