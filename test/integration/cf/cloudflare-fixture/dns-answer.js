const TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28 };

function name(text) {
  const out = [];
  for (const label of text.split('.').filter(Boolean)) {
    const bytes = new TextEncoder().encode(label);
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
  return out;
}

const CDN = 'aem.live.cdn.cloudflare.net';

export const DNS_ANSWERS = {
  'example.com': {
    [TYPES.A]: [[93, 184, 215, 14]],
    [TYPES.AAAA]: [
      [
        0x26, 0x06, 0x28, 0x00, 0x02, 0x1f, 0xcb, 0x07, 0x68, 0x20, 0x80, 0xda, 0xaf, 0x6b, 0x8b,
        0x2c,
      ],
    ],
    [TYPES.MX]: [[0, 10, 4, 109, 97, 105, 108, 0xc0, 0x0c]],
  },
  'big.example.com': {
    [TYPES.TXT]: Array.from({ length: 12 }, (_, i) => {
      const text = `${String(i).padStart(2, '0')}${'x'.repeat(60)}`;
      return [text.length, ...new TextEncoder().encode(text)];
    }),
  },
};

DNS_ANSWERS[CDN] = {
  [TYPES.A]: [
    [104, 18, 1, 1],
    [104, 18, 2, 2],
  ],
  [TYPES.AAAA]: [[0x26, 0x06, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x68, 0x12, 0x01, 0x01]],
};

export const DNS_CHAINS = {
  'www.aem.live': {
    alias: { to: CDN, ttl: 300 },
    [TYPES.A]: {
      ttl: 60,
      records: [
        [104, 18, 1, 1],
        [104, 18, 2, 2],
      ],
    },
    [TYPES.AAAA]: {
      ttl: 60,
      records: [[0x26, 0x06, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x68, 0x12, 0x01, 0x01]],
    },
  },
};

function question(query) {
  const labels = [];
  let at = 12;
  while (query[at]) {
    labels.push(new TextDecoder().decode(query.subarray(at + 1, at + 1 + query[at])));
    at += query[at] + 1;
  }
  const type = (query[at + 1] << 8) | query[at + 2];
  return { name: labels.join('.').toLowerCase(), type, end: at + 5 };
}

function rr(owner, type, ttl, rdata) {
  return [
    ...owner,
    type >> 8,
    type & 0xff,
    0,
    1,
    (ttl >>> 24) & 0xff,
    (ttl >>> 16) & 0xff,
    (ttl >>> 8) & 0xff,
    ttl & 0xff,
    rdata.length >> 8,
    rdata.length & 0xff,
    ...rdata,
  ];
}

function reply(query, end, rcode, records) {
  return new Uint8Array([
    query[0],
    query[1],
    0x81,
    0x80 | rcode,
    0,
    1,
    records.length >> 8,
    records.length & 0xff,
    0,
    0,
    0,
    0,
    ...query.subarray(12, end),
    ...records.flat(),
  ]);
}

export function dnsAnswer(query) {
  const { name: asked, type, end } = question(query);
  if (asked === 'broken.example') return reply(query, end, 2, []);
  const chain = DNS_CHAINS[asked];
  if (chain) {
    const { to, ttl } = chain.alias;
    const records = [rr([0xc0, 0x0c], TYPES.CNAME, ttl, name(to))];
    for (const rdata of chain[type]?.records ?? []) {
      records.push(rr(name(to), type, chain[type].ttl, rdata));
    }
    return reply(query, end, 0, records);
  }
  const known = DNS_ANSWERS[asked];
  const records = (known?.[type] ?? []).map((rdata) => rr([0xc0, 0x0c], type, 300, rdata));
  return reply(query, end, known ? 0 : 3, records);
}
