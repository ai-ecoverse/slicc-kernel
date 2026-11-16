const TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28 };

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

export function dnsAnswer(query) {
  const { name, type, end } = question(query);
  const known = DNS_ANSWERS[name];
  const records = known?.[type] ?? [];
  const rcode = known ? 0 : 3;
  const answers = records.flatMap((rdata) => [
    0xc0,
    0x0c,
    type >> 8,
    type & 0xff,
    0,
    1,
    0,
    0,
    1,
    44,
    rdata.length >> 8,
    rdata.length & 0xff,
    ...rdata,
  ]);
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
    ...answers,
  ]);
}
