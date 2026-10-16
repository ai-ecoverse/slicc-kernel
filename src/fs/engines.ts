type Version = [number, number, number, string[]];

const NUMBER = /^(0|[1-9]\d*)$/;
const PART = /^(?:0|[1-9]\d*|[xX*])$/;

function identifiers(pre: string | undefined): string[] {
  return pre === undefined || pre === '' ? [] : pre.split('.');
}

export function parseVersion(text: string): Version | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!m || ![m[1], m[2], m[3]].every((n) => NUMBER.test(n as string))) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3]), identifiers(m[4])];
}

function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i], b[i]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const [nx, ny] = [NUMBER.test(x), NUMBER.test(y)];
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || comparePre(a[3], b[3]);
}

type Comparator = [op: '<' | '<=' | '>' | '>=' | '=', version: Version];

interface Partial {
  parts: Array<number | undefined>;
  pre: string[];
}

function partial(text: string): Partial | undefined {
  const m =
    /^v?([^.+-]+)(?:\.([^.+-]+))?(?:\.([^.+-]+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      text
    );
  if (!m) return undefined;
  const raw = [m[1], m[2], m[3]];
  if (!raw.every((p) => p === undefined || PART.test(p))) return undefined;
  const parts: Array<number | undefined> = [];
  for (const p of raw) {
    if (p === undefined || /^[xX*]$/.test(p) || parts.includes(undefined)) parts.push(undefined);
    else parts.push(Number(p));
  }
  return { parts, pre: identifiers(m[4]) };
}

function floor(p: Partial): Version {
  const [a = 0, b = 0, c = 0] = p.parts;
  return [a, b, c, p.parts.includes(undefined) ? [] : p.pre];
}

function next(p: Partial): Version | undefined {
  const [a, b] = p.parts;
  if (a === undefined) return undefined;
  if (b === undefined) return [a + 1, 0, 0, ['0']];
  return [a, b + 1, 0, ['0']];
}

const ANY: Comparator[] = [['>=', [0, 0, 0, []]]];

const NOTHING: Comparator[] = [['<', [0, 0, 0, ['0']]]];

function plain(op: string, p: Partial): Comparator[] {
  const exact = !p.parts.includes(undefined);
  const low = floor(p);
  const high = next(p);
  if (op === '>=') return [['>=', low]];
  if (op === '<') return [['<', exact ? low : [low[0], low[1], low[2], ['0']]]];
  if (exact) return [[op === '' ? '=' : (op as Comparator[0]), low]];
  if (op === '>') return high ? [['>=', high]] : NOTHING;
  if (op === '<=') return high ? [['<', high]] : ANY;
  return high
    ? [
        ['>=', low],
        ['<', high],
      ]
    : ANY;
}

function caret(p: Partial): Comparator[] {
  const [a = 0, b, c] = p.parts;
  const low = floor(p);
  if (b === undefined)
    return [
      ['>=', low],
      ['<', [a + 1, 0, 0, ['0']]],
    ];
  if (a > 0)
    return [
      ['>=', low],
      ['<', [a + 1, 0, 0, ['0']]],
    ];
  if (c === undefined || b > 0)
    return [
      ['>=', low],
      ['<', [0, b + 1, 0, ['0']]],
    ];
  return [
    ['>=', low],
    ['<', [0, b, c + 1, ['0']]],
  ];
}

function tilde(p: Partial): Comparator[] {
  const [a = 0, b] = p.parts;
  const low = floor(p);
  return [
    ['>=', low],
    ['<', b === undefined ? [a + 1, 0, 0, ['0']] : [a, b + 1, 0, ['0']]],
  ];
}

function hyphen(from: Partial, to: Partial): Comparator[] {
  const high = to.parts.includes(undefined) ? next(to) : undefined;
  const upper: Comparator[] = to.parts.includes(undefined)
    ? high
      ? [['<', high]]
      : []
    : [['<=', floor(to)]];
  return [['>=', floor(from)], ...upper];
}

function comparator(token: string): Comparator[] | undefined {
  const m = /^(<=|>=|<|>|=|\^|~>?)?\s*(.*)$/.exec(token);
  const op = m?.[1] ?? '';
  const p = partial(m?.[2] ?? '');
  if (!p) return undefined;
  if (op === '^') return caret(p);
  if (op.startsWith('~')) return tilde(p);
  return plain(op, p);
}

function set(text: string): Comparator[] | undefined {
  const trimmed = text.trim().replace(/(<=|>=|<|>|=|\^|~>?)\s+/g, '$1');
  if (trimmed === '') return ANY;
  const range = /^(\S+)\s+-\s+(\S+)$/.exec(trimmed);
  if (range) {
    const [from, to] = [partial(range[1] as string), partial(range[2] as string)];
    return from && to ? hyphen(from, to) : undefined;
  }
  const out: Comparator[] = [];
  for (const token of trimmed.split(/\s+/)) {
    const found = comparator(token);
    if (!found) return undefined;
    out.push(...found);
  }
  return out;
}

function holds(v: Version, [op, w]: Comparator): boolean {
  const c = compare(v, w);
  if (op === '<') return c < 0;
  if (op === '<=') return c <= 0;
  if (op === '>') return c > 0;
  if (op === '>=') return c >= 0;
  return c === 0;
}

export function satisfies(version: string, range: string): boolean | undefined {
  const v = parseVersion(version);
  if (!v) return undefined;
  const sets = range.split('||').map(set);
  if (sets.some((s) => s === undefined)) return undefined;
  return (sets as Comparator[][]).some((s) => s.every((c) => holds(v, c)));
}
