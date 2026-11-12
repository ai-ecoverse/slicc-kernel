import type { EmContext } from './context.ts';

const htons = (v: number): number => ((v & 0xff) << 8) | ((v >> 8) & 0xff);
const htonl = (v: number): number =>
  (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) >>> 0;

function pton4(str: string): number | null {
  const b = str.split('.');
  const n: number[] = [];
  for (let i = 0; i < 4; i++) {
    const tmp = Number(b[i]);
    if (Number.isNaN(tmp)) return null;
    n.push(tmp);
  }
  return (
    ((n[0] as number) |
      ((n[1] as number) << 8) |
      ((n[2] as number) << 16) |
      ((n[3] as number) << 24)) >>>
    0
  );
}

const VALID6 =
  /^((?=.*::)(?!.*::.+::)(::)?([\dA-F]{1,4}:(:|\b)|){5}|([\dA-F]{1,4}:){6})((([\dA-F]{1,4}((?!\3)::|:\b|$))|(?!\2\3)){2}|(((2[0-4]|1\d|[1-9])?\d|25[0-5])\.?\b){4})$/i;

function pton6(input: string): number[] | null {
  if (!VALID6.test(input)) return null;
  if (input === '::') return [0, 0, 0, 0, 0, 0, 0, 0];
  let str = input.startsWith('::') ? input.replace('::', 'Z:') : input.replace('::', ':Z:');
  let words: Array<string | number>;
  if (str.indexOf('.') > 0) {
    str = str.replace(/[.]/g, ':');
    words = str.split(':');
    const n = words.length;
    words[n - 4] = Number(words[n - 4]) + Number(words[n - 3]) * 256;
    words[n - 3] = Number(words[n - 2]) + Number(words[n - 1]) * 256;
    words = words.slice(0, n - 2);
  } else {
    words = str.split(':');
  }
  const parts: number[] = [];
  let offset = 0;
  for (let w = 0; w < words.length; w++) {
    const word = words[w];
    if (typeof word === 'string') {
      if (word === 'Z') {
        let z = 0;
        for (z = 0; z < 8 - words.length + 1; z++) parts[w + z] = 0;
        offset = z - 1;
      } else {
        parts[w + offset] = htons(Number.parseInt(word, 16));
      }
    } else {
      parts[w + offset] = word as number;
    }
  }
  const p = (i: number) => parts[i] ?? 0;
  return [(p(1) << 16) | p(0), (p(3) << 16) | p(2), (p(5) << 16) | p(4), (p(7) << 16) | p(6)];
}

const names = new Map<string, string>();
let nextId = 1;

function lookupName(name: string): string {
  if (pton4(name) !== null || pton6(name) !== null) return name;
  const known = names.get(name);
  if (known) return known;
  const id = nextId++;
  const addr = `172.29.${id & 0xff}.${id & 0xff00}`;
  names.set(name, addr);
  return addr;
}

function writeSockaddr(
  ctx: EmContext,
  sa: number,
  family: number,
  addr: number | number[],
  port: number
): void {
  const v = ctx.mem.view();
  if (family === 2) {
    ctx.mem.bytes(sa, 16).fill(0);
    v.setInt16(sa, family, true);
    v.setInt32(sa + 4, addr as number, true);
    v.setInt16(sa + 2, htons(port), true);
    return;
  }
  const a = addr as number[];
  ctx.mem.bytes(sa, 28).fill(0);
  v.setInt32(sa, family, true);
  for (let i = 0; i < 4; i++) v.setInt32(sa + 8 + i * 4, a[i] ?? 0, true);
  v.setInt16(sa + 2, htons(port), true);
}

function allocInfo(
  ctx: EmContext,
  ai: {
    family: number;
    type: number;
    proto: number;
    canon: number;
    addr: number | number[];
    port: number;
  }
): number {
  const malloc = ctx.exports().malloc as (n: number) => number;
  const salen = ai.family === 10 ? 28 : 16;
  const sa = malloc(salen);
  writeSockaddr(ctx, sa, ai.family, ai.addr, ai.port);
  const out = malloc(32);
  const v = ctx.mem.view();
  v.setInt32(out + 4, ai.family, true);
  v.setInt32(out + 8, ai.type, true);
  v.setInt32(out + 12, ai.proto, true);
  v.setUint32(out + 24, ai.canon >>> 0, true);
  v.setUint32(out + 20, sa, true);
  v.setInt32(out + 16, salen, true);
  v.setInt32(out + 28, 0, true);
  return out;
}

interface Hints {
  flags: number;
  family: number;
  type: number;
  proto: number;
}

function hintsOf(ctx: EmContext, hint: number): Hints {
  const v = ctx.mem.view();
  const h = hint
    ? {
        flags: v.getInt32(hint, true),
        family: v.getInt32(hint + 4, true),
        type: v.getInt32(hint + 8, true),
        proto: v.getInt32(hint + 12, true),
      }
    : { flags: 0, family: 0, type: 0, proto: 0 };
  if (h.type && !h.proto) h.proto = h.type === 2 ? 17 : 6;
  if (!h.type && h.proto) h.type = h.proto === 17 ? 2 : 1;
  if (h.proto === 0) h.proto = 6;
  if (h.type === 0) h.type = 1;
  return h;
}

function refused(h: Hints, node: number, service: number): number {
  if (!node && !service) return -2;
  if (h.flags & ~(1 | 2 | 4 | 1024 | 8 | 16 | 32)) return -1;
  if (h.flags & 2 && !node) return -1;
  if (h.flags & 32) return -2;
  if (h.type !== 0 && h.type !== 1 && h.type !== 2) return -7;
  if (h.family !== 0 && h.family !== 2 && h.family !== 10) return -6;
  return 0;
}

function numeric(h: Hints, node: string): number | number[] | null | undefined {
  const four = pton4(node);
  if (four !== null) {
    if (h.family === 0 || h.family === 2) {
      h.family = 2;
      return four;
    }
    if (h.family === 10 && h.flags & 8) return [0, 0, htonl(0xffff), four];
    return undefined;
  }
  const six = pton6(node);
  if (six === null) return null;
  if (h.family !== 0 && h.family !== 10) return undefined;
  h.family = 10;
  return six;
}

function getaddrinfo(
  ctx: EmContext,
  nodePtr: number,
  servicePtr: number,
  hint: number,
  out: number
): number {
  const h = hintsOf(ctx, hint);
  const bad = refused(h, nodePtr, servicePtr);
  if (bad !== 0) return bad;
  let port = 0;
  if (servicePtr) {
    port = Number.parseInt(ctx.mem.cString(servicePtr), 10);
    if (Number.isNaN(port)) return h.flags & 1024 ? -2 : -8;
  }
  const put = (canon: number, addr: number | number[]) => {
    const ai = allocInfo(ctx, {
      family: h.family,
      type: h.type,
      proto: h.proto,
      canon,
      addr,
      port,
    });
    ctx.mem.view().setUint32(out, ai, true);
    return 0;
  };
  if (!nodePtr) {
    if (h.family === 0) h.family = 2;
    if (h.flags & 1) return put(0, 0);
    return put(0, h.family === 2 ? htonl(2130706433) : [0, 0, 0, htonl(1)]);
  }
  const node = ctx.mem.cString(nodePtr);
  const addr = numeric(h, node);
  if (addr === undefined) return -2;
  if (addr !== null) return put(Number(node) >>> 0, addr);
  if (h.flags & 4) return -2;
  const fake = pton4(lookupName(node)) as number;
  if (h.family === 0) h.family = 2;
  return put(0, h.family === 10 ? [0, 0, htonl(0xffff), fake] : fake);
}

export function dnsImports(ctx: EmContext): Record<string, unknown> {
  return {
    getaddrinfo: (node: number, service: number, hint: number, out: number) =>
      getaddrinfo(ctx, node, service, hint, out),
    _emscripten_lookup_name: (name: number) => pton4(lookupName(ctx.mem.cString(name))),
  };
}
