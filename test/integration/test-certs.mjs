import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const cat = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));

function length(n) {
  if (n < 0x80) return Buffer.of(n);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.of(0x80 | bytes.length, ...bytes);
}

const tlv = (tag, ...parts) => {
  const body = cat(parts);
  return cat([Buffer.of(tag), length(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const octets = (b) => tlv(0x04, b);
const bits = (b, unused = 0) => tlv(0x03, Buffer.of(unused), b);
const TRUE = Buffer.of(0x01, 0x01, 0xff);

function integer(magnitude) {
  let b = Buffer.from(magnitude);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  return tlv(0x02, b[0] & 0x80 ? cat([Buffer.of(0), b]) : b);
}

function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const groups = [];
    for (let v = n; ; v = Math.floor(v / 128)) {
      groups.unshift(v % 128);
      if (v < 128) break;
    }
    out.push(...groups.map((g, i) => (i < groups.length - 1 ? g | 0x80 : g)));
  }
  return tlv(0x06, Buffer.from(out));
}

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function time(date) {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(2, 14);
  return tlv(0x17, Buffer.from(`${iso}Z`));
}

const name = (cn) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));

const extension = (id, critical, value) =>
  critical ? seq(oid(id), TRUE, octets(value)) : seq(oid(id), octets(value));

function publicKeyBits(spki) {
  const s = Buffer.from(spki);
  let at = 2 + (s[1] & 0x80 ? s[1] & 0x7f : 0);
  const algLen = s[at + 1];
  at += 2 + algLen;
  return s.subarray(at + 3);
}

const keyId = (spki) => createHash('sha1').update(publicKeyBits(spki)).digest();

function ipBytes(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m ? Buffer.from(m.slice(1).map(Number)) : undefined;
}

function certificate(o) {
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const exts = [extension('2.5.29.14', false, octets(keyId(o.spki)))];
  if (o.ca) {
    exts.push(extension('2.5.29.19', true, seq(TRUE)));
    exts.push(extension('2.5.29.15', true, bits(Buffer.of(0x86), 1)));
  } else {
    exts.push(extension('2.5.29.35', false, seq(tlv(0x80, keyId(o.issuerSpki)))));
    exts.push(extension('2.5.29.15', true, bits(Buffer.of(0x80), 7)));
    exts.push(extension('2.5.29.37', false, seq(oid(o.eku ?? '1.3.6.1.5.5.7.3.1'))));
    const ip = o.san === 'dns' ? undefined : ipBytes(o.host);
    exts.push(
      extension('2.5.29.17', false, seq(ip ? tlv(0x87, ip) : tlv(0x82, Buffer.from(o.host))))
    );
  }
  const tbs = seq(
    tlv(0xa0, integer(Buffer.of(2))),
    integer(serial),
    ECDSA_SHA256,
    name(o.issuer),
    seq(time(o.notBefore), time(o.notAfter)),
    name(o.subject),
    Buffer.from(o.spki),
    tlv(0xa3, seq(...exts))
  );
  return seq(tbs, ECDSA_SHA256, bits(sign('sha256', tbs, o.key)));
}

export function pem(der) {
  const lines = Buffer.from(der)
    .toString('base64')
    .match(/.{1,64}/g);
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

const DAY = 86400_000;

export function makeCa(cn = 'slicc-kernel test CA') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const now = Date.now();
  const der = certificate({
    issuer: cn,
    subject: cn,
    notBefore: new Date(now - DAY),
    notAfter: new Date(now + 365 * DAY),
    spki,
    ca: true,
    key: privateKey,
  });
  return {
    der,
    pem: pem(der),
    server(
      host,
      { notBefore = new Date(now - 3600_000), notAfter = new Date(now + 7 * DAY), san, eku } = {}
    ) {
      const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const leaf = certificate({
        issuer: cn,
        subject: host,
        notBefore,
        notAfter,
        spki: pair.publicKey.export({ type: 'spki', format: 'der' }),
        issuerSpki: spki,
        host,
        san,
        eku,
        key: privateKey,
      });
      return {
        der: leaf,
        cert: pem(leaf) + pem(der),
        key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      };
    },
  };
}

export function selfSigned(host) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
  const now = Date.now();
  const der = certificate({
    issuer: host,
    subject: host,
    notBefore: new Date(now - 3600_000),
    notAfter: new Date(now + 7 * DAY),
    spki,
    issuerSpki: spki,
    host,
    key: pair.privateKey,
  });
  return { der, cert: pem(der), key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
