import { MIN_VALUE } from '@ai-ecoverse/slicc-scrub';
import { SESSION_PLACEHOLDERS, type SessionHead } from '../sealed-session.ts';

export const HTTP1_METHODS: readonly string[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS',
  'CONNECT',
  'TRACE',
];

export const HEAD_MAX = 16 * 1024;

const ANY_PLACEHOLDER = /fnox_proxy_[0-9a-f]{24}/g;
const REQUEST_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) ([\x21-\x7e]+) HTTP\/1\.[01]$/;
const HEADER_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*?)[ \t]*$/;
const BASIC = /^(Basic[ \t]+)([A-Za-z0-9+/]+={0,2})$/i;

export type HeadAsk = (
  position: string,
  placeholders: string[],
  head: SessionHead
) => Promise<Record<string, string> | undefined>;

export interface Substituted {
  head: string;
  values: Record<string, string>;
}

const encoder = new TextEncoder();

function binary(text: string): string {
  let out = '';
  for (const b of encoder.encode(text)) out += String.fromCharCode(b);
  return out;
}

export function sniffHttp1(start: string): 'yes' | 'no' | 'more' {
  for (const method of HTTP1_METHODS) {
    const word = `${method} `;
    if (start.startsWith(word)) return 'yes';
    if (word.startsWith(start)) return 'more';
  }
  return 'no';
}

interface Found {
  line: number;
  name: string;
  value: string;
  basic: { scheme: string; decoded: string } | undefined;
  placeholders: string[];
}

function basicOf(value: string): Found['basic'] {
  const m = BASIC.exec(value);
  if (!m) return undefined;
  try {
    return { scheme: m[1] as string, decoded: atob(m[2] as string) };
  } catch {
    return undefined;
  }
}

function placeholdersIn(text: string): string[] {
  return [...new Set(text.match(ANY_PLACEHOLDER) ?? [])];
}

function scan(lines: readonly string[]): Found[] | undefined {
  const found: Found[] = [];
  for (let i = 1; i < lines.length; i++) {
    const m = HEADER_LINE.exec(lines[i] as string);
    if (!m) return undefined;
    const value = m[2] as string;
    const basic = basicOf(value);
    const placeholders = placeholdersIn(basic ? basic.decoded : value);
    if (placeholders.length > 0)
      found.push({ line: i, name: (m[1] as string).toLowerCase(), value, basic, placeholders });
  }
  return found;
}

function replaced(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [ph, value] of Object.entries(values)) out = out.split(ph).join(binary(value));
  return out;
}

function usable(values: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ph, value] of Object.entries(values ?? {}))
    if (encoder.encode(value).length >= MIN_VALUE) out[ph] = value;
  return out;
}

export async function substituteHead(head: string, ask: HeadAsk): Promise<Substituted | undefined> {
  if (!head.endsWith('\r\n\r\n')) return undefined;
  const lines = head.slice(0, -4).split('\r\n');
  if (lines.some((l) => l.includes('\n') || l.includes('\r'))) return undefined;
  const request = REQUEST_LINE.exec(lines[0] as string);
  const found = request ? scan(lines) : undefined;
  if (!request || !found || found.length !== 1) return undefined;
  const at = found[0] as Found;
  if (at.placeholders.length > SESSION_PLACEHOLDERS) return undefined;
  const values = usable(
    await ask(`header:${at.name}`, at.placeholders, {
      method: request[1] as string,
      path: request[2] as string,
    })
  );
  if (Object.keys(values).length === 0) return undefined;
  const value = at.basic
    ? `${at.basic.scheme}${btoa(replaced(at.basic.decoded, values))}`
    : replaced(at.value, values);
  const out = [...lines];
  out[at.line] = `${(lines[at.line] as string).split(':')[0]}: ${value}`;
  return { head: `${out.join('\r\n')}\r\n\r\n`, values };
}
