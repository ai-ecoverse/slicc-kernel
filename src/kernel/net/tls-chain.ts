import { verifyCode } from './tls-client.ts';

const CN_MISMATCH = 0x04;
const NOT_TRUSTED = 0x08;

interface Tlv {
  start: number;
  body: number;
  end: number;
}

function tlv(der: Uint8Array, at: number): Tlv | undefined {
  if (at + 2 > der.length) return undefined;
  const first = der[at + 1] as number;
  let body = at + 2;
  let length = first;
  if (first & 0x80) {
    const n = first & 0x7f;
    if (n === 0 || n > 4 || body + n > der.length) return undefined;
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + (der[body + i] as number);
    body += n;
  }
  const end = body + length;
  return end > der.length ? undefined : { start: at, body, end };
}

function children(der: Uint8Array, outer: Tlv, max: number): Tlv[] | undefined {
  const fields: Tlv[] = [];
  for (let at = outer.body; at < outer.end && fields.length < max; ) {
    const field = tlv(der, at);
    if (!field) return undefined;
    fields.push(field);
    at = field.end;
  }
  return fields;
}

function tbsFields(der: Uint8Array): { cert: Tlv[]; tbs: Tlv[] } | undefined {
  const outer = tlv(der, 0);
  const cert = outer && children(der, outer, 3);
  const tbs = cert?.[0] && children(der, cert[0], 8);
  if (!cert || !tbs) return undefined;
  return { cert, tbs: der[tbs[0]?.start ?? 0] === 0xa0 ? tbs.slice(1) : tbs };
}

const raw = (der: Uint8Array, t: Tlv): Uint8Array => der.subarray(t.start, t.end);

function names(der: Uint8Array): [Uint8Array, Uint8Array] | undefined {
  const fields = tbsFields(der)?.tbs;
  const [, , issuer, , subject] = fields ?? [];
  if (!issuer || !subject) return undefined;
  return [raw(der, issuer), raw(der, subject)];
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const HASHES: Record<string, [string, string]> = {
  '2a864886f70d01010b': ['RSASSA-PKCS1-v1_5', 'SHA-256'],
  '2a864886f70d01010c': ['RSASSA-PKCS1-v1_5', 'SHA-384'],
  '2a864886f70d01010d': ['RSASSA-PKCS1-v1_5', 'SHA-512'],
  '2a8648ce3d040302': ['ECDSA', 'SHA-256'],
  '2a8648ce3d040303': ['ECDSA', 'SHA-384'],
  '2a8648ce3d040304': ['ECDSA', 'SHA-512'],
  '2b6570': ['Ed25519', ''],
  '2a864886f70d01010a': ['RSA-PSS', 'SHA-1'],
};

const PSS_HASHES: Record<string, string> = {
  '2b0e03021a': 'SHA-1',
  '608648016503040201': 'SHA-256',
  '608648016503040202': 'SHA-384',
  '608648016503040203': 'SHA-512',
};

function pssOf(der: Uint8Array, algorithm: Tlv): { hash: string; salt: number } | undefined {
  const params = children(der, algorithm, 2)?.[1];
  let hash = 'SHA-1';
  let salt = 20;
  for (const field of params && der[params.start] === 0x30
    ? (children(der, params, 3) ?? [])
    : []) {
    const inner = tlv(der, field.body);
    if (!inner) return undefined;
    if (der[field.start] === 0xa0) {
      const known = PSS_HASHES[oidOf(der, inner) ?? ''];
      if (!known) return undefined;
      hash = known;
    } else if (der[field.start] === 0xa2) {
      salt = der.subarray(inner.body, inner.end).reduce((n, b) => n * 256 + b, 0);
    }
  }
  return { hash, salt };
}

const CURVES: Record<string, [string, number]> = {
  '2a8648ce3d030107': ['P-256', 32],
  '2b81040022': ['P-384', 48],
  '2b81040023': ['P-521', 66],
};

function oidOf(der: Uint8Array, algorithm: Tlv, index = 0): string | undefined {
  const parts = children(der, algorithm, 2);
  const oid = parts?.[index];
  return oid && der[oid.start] === 0x06 ? hex(der.subarray(oid.body, oid.end)) : undefined;
}

function curveOf(der: Uint8Array, spki: Tlv): [string, number] | undefined {
  const algorithm = children(der, spki, 1)?.[0];
  const curve = algorithm && oidOf(der, algorithm, 1);
  return curve ? CURVES[curve] : undefined;
}

function fixedEcdsa(sig: Uint8Array, size: number): Uint8Array | undefined {
  const outer = tlv(sig, 0);
  const ints = outer && children(sig, outer, 2);
  if (ints?.length !== 2) return undefined;
  const out = new Uint8Array(size * 2);
  for (const [i, int] of ints.entries()) {
    let value = sig.subarray(int.body, int.end);
    while (value.length > size && value[0] === 0) value = value.subarray(1);
    if (value.length > size) return undefined;
    out.set(value, (i + 1) * size - value.length);
  }
  return out;
}

interface Signed {
  tbs: Uint8Array;
  spki: Uint8Array;
  signature: Uint8Array;
  scheme: string;
  hash: string;
  curve?: [string, number];
  salt?: number;
}

function signedOf(der: Uint8Array): Signed | undefined {
  const parts = tbsFields(der);
  const [tbs, algorithm, value] = parts?.cert ?? [];
  const spki = parts?.tbs[5];
  if (!tbs || !algorithm || !value || !spki || der[value.start] !== 0x03) return undefined;
  const known = HASHES[oidOf(der, algorithm) ?? ''];
  if (!known) return undefined;
  const [scheme] = known;
  const pss = scheme === 'RSA-PSS' ? pssOf(der, algorithm) : undefined;
  if (scheme === 'RSA-PSS' && !pss) return undefined;
  const hash = pss?.hash ?? known[1];
  const curve = scheme === 'ECDSA' ? curveOf(der, spki) : undefined;
  if (scheme === 'ECDSA' && !curve) return undefined;
  const signature = der.subarray(value.body + 1, value.end);
  return {
    tbs: raw(der, tbs),
    spki: raw(der, spki),
    signature,
    scheme,
    hash,
    ...(curve ? { curve } : {}),
    ...(pss ? { salt: pss.salt } : {}),
  };
}

async function verifiesItself(s: Signed): Promise<boolean> {
  const name = s.curve?.[0];
  const algorithm =
    s.scheme === 'ECDSA'
      ? { name: 'ECDSA', namedCurve: name }
      : s.hash
        ? { name: s.scheme, hash: s.hash }
        : { name: s.scheme };
  const key = await crypto.subtle.importKey('spki', new Uint8Array(s.spki), algorithm, false, [
    'verify',
  ]);
  const signature = s.curve ? fixedEcdsa(s.signature, s.curve[1]) : s.signature;
  if (!signature) return false;
  const params =
    s.scheme === 'ECDSA'
      ? { name: 'ECDSA', hash: s.hash }
      : s.salt === undefined
        ? { name: s.scheme }
        : { name: s.scheme, saltLength: s.salt };
  return crypto.subtle.verify(params, key, new Uint8Array(signature), new Uint8Array(s.tbs));
}

export async function selfSigned(der: Uint8Array | undefined): Promise<boolean> {
  if (!selfIssued(der)) return false;
  const signed = signedOf(der as Uint8Array);
  if (!signed) return false;
  return verifiesItself(signed).catch(() => false);
}

export interface ChainShape {
  leafSelfSigned: boolean;
  topSelfSigned: boolean;
}

export async function chainShape(chain: readonly Uint8Array[]): Promise<ChainShape> {
  return {
    leafSelfSigned: chain.length === 1 && (await selfSigned(chain[0])),
    topSelfSigned: chain.length > 1 && (await selfSigned(chain.at(-1))),
  };
}

function selfIssued(der: Uint8Array | undefined): der is Uint8Array {
  const pair = der && names(der);
  if (!pair) return false;
  const [issuer, subject] = pair;
  return issuer.length === subject.length && issuer.every((b, i) => b === subject[i]);
}

function untrusted(chain: readonly Uint8Array[], shape: ChainShape): string {
  if (chain.length === 1) {
    return shape.leafSelfSigned ? 'DEPTH_ZERO_SELF_SIGNED_CERT' : 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  }
  return shape.topSelfSigned ? 'SELF_SIGNED_CERT_IN_CHAIN' : 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY';
}

export function chainError(
  flags: number,
  chain: readonly Uint8Array[],
  shape: ChainShape
): string | undefined {
  if (flags === -1) return 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  const rest = flags & ~CN_MISMATCH;
  if (rest === 0) return undefined;
  if (rest & NOT_TRUSTED) return untrusted(chain, shape);
  return verifyCode(rest);
}

export function nameMatches(flags: number): boolean {
  return flags !== -1 && (flags & CN_MISMATCH) === 0;
}
