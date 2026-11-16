const encoder = new TextEncoder();

function leb(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

const named = (text) => {
  const bytes = [...encoder.encode(text)];
  return [...leb(bytes.length), ...bytes];
};

const section = (id, body) => [id, ...leb(body.length), ...body];

export function messageWasm(message, { fill = 0, tag = message } = {}) {
  const text = [...encoder.encode(message)];
  const iov = [32, 0, 0, 0, text.length & 0xff, (text.length >> 8) & 0xff, 0, 0];
  const segment = [...iov, ...new Array(24).fill(0), ...text];
  const head = [
    0x00,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...section(1, [2, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
    ...section(2, [1, ...named('wasi_snapshot_preview1'), ...named('fd_write'), 0, 0]),
    ...section(3, [1, 1]),
    ...section(5, [1, 0, 1]),
    ...section(7, [2, ...named('memory'), 2, 0, ...named('_start'), 0, 1]),
    ...section(10, [1, ...leb(13), 0, 0x41, 1, 0x41, 0, 0x41, 1, 0x41, 16, 0x10, 0, 0x1a, 0x0b]),
    ...section(11, [1, 0, 0x41, 0, 0x0b, ...leb(segment.length), ...segment]),
  ];
  if (fill === 0) return { head: new Uint8Array(head), fill: 0 };
  const name = named(`filler ${tag}`);
  return {
    head: new Uint8Array([...head, 0, ...leb(name.length + fill), ...name]),
    fill,
  };
}

export function whole({ head, fill }) {
  const out = new Uint8Array(head.length + fill);
  out.set(head);
  return out;
}

export const printfOf = (bytes) =>
  [...bytes].map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('');
