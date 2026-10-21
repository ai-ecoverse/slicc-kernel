import { readFileSync, writeFileSync } from 'node:fs';

const [from, to, label] = process.argv.slice(2);
const bytes = readFileSync(from);
const leb = (at) => {
  let value = 0;
  let shift = 0;
  for (;;) {
    const b = bytes[at++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) return [value, at];
  }
};
const encode = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const parts = [bytes.subarray(0, 8)];
let at = 8;
let found = false;
while (at < bytes.length) {
  const id = bytes[at];
  const [size, body] = leb(at + 1);
  const end = body + size;
  if (id === 0) {
    const [len, nameAt] = leb(body);
    const name = bytes.subarray(nameAt, nameAt + len).toString();
    if (name === 'slicc.libc') {
      found = true;
      const payload = [...encode(len), ...Buffer.from(name), ...Buffer.from(label)];
      parts.push(Buffer.from([0, ...encode(payload.length), ...payload]));
      at = end;
      continue;
    }
  }
  parts.push(bytes.subarray(at, end));
  at = end;
}
if (!found) throw new Error(`${from} has no slicc.libc section`);
writeFileSync(to, Buffer.concat(parts));
