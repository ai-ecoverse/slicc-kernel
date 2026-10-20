const HASH_OF_SIGNATURE: Readonly<Record<string, string>> = {
  '1.2.840.113549.1.1.4': 'SHA-256',
  '1.2.840.113549.1.1.5': 'SHA-256',
  '1.2.840.10045.4.1': 'SHA-256',
  '1.2.840.10040.4.3': 'SHA-256',
  '1.2.840.113549.1.1.11': 'SHA-256',
  '1.2.840.10045.4.3.2': 'SHA-256',
  '1.2.840.113549.1.1.12': 'SHA-384',
  '1.2.840.10045.4.3.3': 'SHA-384',
  '1.2.840.113549.1.1.13': 'SHA-512',
  '1.2.840.10045.4.3.4': 'SHA-512',
};

interface Tlv {
  tag: number;
  start: number;
  end: number;
}

function tlv(der: Uint8Array, at: number): Tlv | undefined {
  const tag = der[at];
  let len = der[at + 1];
  if (tag === undefined || len === undefined) return undefined;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) return undefined;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (der[start + i] ?? 0);
    start += n;
  }
  const end = start + len;
  return end <= der.length ? { tag, start, end } : undefined;
}

function oidText(bytes: Uint8Array): string {
  const first = bytes[0] ?? 0;
  const parts = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (const b of bytes.subarray(1)) {
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

export function signatureOid(cert: Uint8Array): string | undefined {
  const outer = tlv(cert, 0);
  if (outer?.tag !== 0x30) return undefined;
  const tbs = tlv(cert, outer.start);
  if (tbs?.tag !== 0x30) return undefined;
  const algorithm = tlv(cert, tbs.end);
  if (algorithm?.tag !== 0x30) return undefined;
  const oid = tlv(cert, algorithm.start);
  if (oid?.tag !== 0x06) return undefined;
  return oidText(cert.subarray(oid.start, oid.end));
}

export async function endPointBinding(
  cert: Uint8Array | undefined
): Promise<Uint8Array | undefined> {
  if (!cert) return undefined;
  const oid = signatureOid(cert);
  const hash = oid === undefined ? undefined : HASH_OF_SIGNATURE[oid];
  if (!hash) return undefined;
  return new Uint8Array(await crypto.subtle.digest(hash, cert as Uint8Array<ArrayBuffer>));
}
