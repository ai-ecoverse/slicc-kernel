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

function names(der: Uint8Array): [Uint8Array, Uint8Array] | undefined {
  const cert = tlv(der, 0);
  const tbs = cert && tlv(der, cert.body);
  if (!tbs) return undefined;
  const fields: Tlv[] = [];
  for (let at = tbs.body; at < tbs.end && fields.length < 6; ) {
    const field = tlv(der, at);
    if (!field) return undefined;
    if (fields.length > 0 || der[at] !== 0xa0) fields.push(field);
    at = field.end;
  }
  const [, , issuer, , subject] = fields;
  if (!issuer || !subject) return undefined;
  return [der.subarray(issuer.start, issuer.end), der.subarray(subject.start, subject.end)];
}

function selfIssued(der: Uint8Array | undefined): boolean {
  const pair = der && names(der);
  if (!pair) return false;
  const [issuer, subject] = pair;
  return issuer.length === subject.length && issuer.every((b, i) => b === subject[i]);
}

function untrusted(chain: readonly Uint8Array[]): string {
  if (chain.length === 1) {
    return selfIssued(chain[0]) ? 'DEPTH_ZERO_SELF_SIGNED_CERT' : 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  }
  return selfIssued(chain.at(-1))
    ? 'SELF_SIGNED_CERT_IN_CHAIN'
    : 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY';
}

export function chainError(flags: number, chain: readonly Uint8Array[]): string | undefined {
  if (flags === -1) return 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  const rest = flags & ~CN_MISMATCH;
  if (rest === 0) return undefined;
  if (rest & NOT_TRUSTED) return untrusted(chain);
  return verifyCode(rest);
}

export function nameMatches(flags: number): boolean {
  return flags !== -1 && (flags & CN_MISMATCH) === 0;
}
