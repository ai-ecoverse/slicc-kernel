import { SESSION_PLACEHOLDERS } from '../sealed-session.ts';
import { placeholdersIn, replaced, usable } from './sealed-http1.ts';

export const PG_MESSAGE_MAX = 16 * 1024;

const PROTOCOL_3 = 0x00030000;
const CLEARTEXT = 3;

export type PgAsk = (placeholders: string[]) => Promise<Record<string, string> | undefined>;

function int32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] as number) << 24) |
    ((bytes[at + 1] as number) << 16) |
    ((bytes[at + 2] as number) << 8) |
    (bytes[at + 3] as number)
  );
}

export function sniffPg(start: string): 'yes' | 'no' | 'more' {
  const bytes = Uint8Array.from(start, (c) => c.charCodeAt(0));
  if (bytes.length === 0 || bytes[0] !== 0) return bytes.length === 0 ? 'more' : 'no';
  if (bytes.length < 8) return 'more';
  const length = int32(bytes, 0);
  return length >= 8 && length <= PG_MESSAGE_MAX && int32(bytes, 4) === PROTOCOL_3 ? 'yes' : 'no';
}

export class PgServer {
  private buffer = new Uint8Array(0);
  private skip = 0;
  private lost = false;
  cleartext = false;

  feed(bytes: Uint8Array): void {
    if (this.lost) return;
    const data = new Uint8Array(this.buffer.length + bytes.length);
    data.set(this.buffer);
    data.set(bytes, this.buffer.length);
    let at = 0;
    for (;;) {
      const left = data.length - at;
      if (this.skip > 0) {
        const n = Math.min(this.skip, left);
        this.skip -= n;
        at += n;
        if (this.skip > 0) break;
        continue;
      }
      if (left < 5) break;
      const type = data[at] as number;
      const whole = 1 + int32(data, at + 1);
      if (whole < 5 || (type === 0x52 && whole > PG_MESSAGE_MAX)) {
        this.lost = true;
        this.cleartext = false;
        this.buffer = new Uint8Array(0);
        return;
      }
      if (type !== 0x52) {
        this.skip = whole;
        continue;
      }
      if (left < whole) break;
      this.cleartext = whole === 9 && int32(data, at + 5) === CLEARTEXT;
      at += whole;
    }
    this.buffer = data.slice(at);
  }
}

export interface PgFrame {
  bytes: Uint8Array;
  values?: Record<string, string>;
  done: boolean;
}

function frame(type: number, body: string): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  const length = 4 + body.length;
  out.set([(length >>> 24) & 255, (length >>> 16) & 255, (length >>> 8) & 255, length & 255], 1);
  for (let i = 0; i < body.length; i++) out[5 + i] = body.charCodeAt(i);
  return out;
}

export function pgLength(bytes: Uint8Array, started: boolean): number | undefined {
  const header = started ? 5 : 4;
  if (bytes.length < header) return undefined;
  const length = int32(bytes, started ? 1 : 0);
  return started ? 1 + length : length;
}

export async function pgPassword(
  message: Uint8Array,
  server: PgServer,
  ask: PgAsk
): Promise<PgFrame> {
  if (message[0] !== 0x70 || !server.cleartext) return { bytes: message, done: true };
  server.cleartext = false;
  let body = '';
  for (const b of message.subarray(5)) body += String.fromCharCode(b);
  if (!body.endsWith('\0') || body.indexOf('\0') !== body.length - 1)
    return { bytes: message, done: true };
  const password = body.slice(0, -1);
  const placeholders = placeholdersIn(password);
  if (placeholders.length === 0 || placeholders.length > SESSION_PLACEHOLDERS)
    return { bytes: message, done: true };
  const values = usable(await ask(placeholders));
  if (Object.keys(values).length === 0) return { bytes: message, done: true };
  return { bytes: frame(0x70, `${replaced(password, values)}\0`), values, done: true };
}
