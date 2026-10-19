import { prepFails } from './saslprep-tables.ts';

const encoder = new TextEncoder();

export interface ScramExchange {
  clientFirstBare: string;
  serverFirst: string;
  clientFinalBare: string;
  salt: Uint8Array;
  iterations: number;
}

export interface ScramKeys {
  proof: Uint8Array;
  serverSignature: Uint8Array;
}

function base64Bytes(text: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
}

export function base64Of(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function clientFirstBare(message: string): string | undefined {
  const m = /^n,,(n=[^,]*,r=[^,]+)$/.exec(message);
  return m ? (m[1] as string) : undefined;
}

const SERVER_FIRST = /^r=([^,]+),s=([^,]+),i=(\d{1,6})$/;
const CLIENT_FINAL = /^(c=biws,r=([^,]+)),p=([^,]+)$/;
const SCRAM_MAX = 1024;

export function exchangeOf(
  clientFirst: string,
  serverFirst: string,
  clientFinal: string
): { exchange: ScramExchange; proof: Uint8Array } | undefined {
  const bare = clientFirstBare(clientFirst);
  const sf = SERVER_FIRST.exec(serverFirst);
  const fin = CLIENT_FINAL.exec(clientFinal);
  if (!bare || !sf || !fin || [bare, serverFirst, clientFinal].some((t) => t.length > SCRAM_MAX))
    return undefined;
  const cnonce = bare.slice(bare.indexOf(',r=') + 3);
  const nonce = sf[1] as string;
  const salt = base64Bytes(sf[2] as string);
  const iterations = Number(sf[3]);
  const proof = base64Bytes(fin[3] as string);
  const ok =
    fin[2] === nonce &&
    nonce.startsWith(cnonce) &&
    iterations >= 1 &&
    iterations <= 100_000 &&
    salt !== undefined &&
    proof?.length === 32;
  if (!ok) return undefined;
  return {
    exchange: {
      clientFirstBare: bare,
      serverFirst,
      clientFinalBare: fin[1] as string,
      salt: salt as Uint8Array,
      iterations,
    },
    proof: proof as Uint8Array,
  };
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw',
    key as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as Uint8Array<ArrayBuffer>));
}

export async function scramKeys(password: string, x: ScramExchange): Promise<ScramKeys> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const salted = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: x.salt as Uint8Array<ArrayBuffer>,
        iterations: x.iterations,
      },
      base,
      256
    )
  );
  const clientKey = await hmac(salted, encoder.encode('Client Key'));
  const stored = new Uint8Array(
    await crypto.subtle.digest('SHA-256', clientKey as Uint8Array<ArrayBuffer>)
  );
  const auth = encoder.encode(`${x.clientFirstBare},${x.serverFirst},${x.clientFinalBare}`);
  const signature = await hmac(stored, auth);
  const proof = clientKey.map((b, i) => b ^ (signature[i] as number));
  const serverKey = await hmac(salted, encoder.encode('Server Key'));
  const serverSignature = await hmac(serverKey, auth);
  for (const k of [salted, clientKey, stored, signature, serverKey]) k.fill(0);
  return { proof, serverSignature };
}

const SPACES = /[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g;
const NOTHING = /\u00AD|\u034F|\u1806|[\u180B-\u180D]|\u200C|\u200D|\u2060|[\uFE00-\uFE0F]|\uFEFF/g;
export function saslprep(password: string): string {
  if (/^[\x00-\x7f]*$/.test(password)) return password;
  const mapped = password.replace(SPACES, ' ').replace(NOTHING, '');
  return prepFails(mapped) ? password : mapped.normalize('NFKC');
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}
