import { concat, HttpError, type Incoming, latin1Bytes } from '../kernel/net/http1.ts';
import type { HeaderList } from '../kernel/net/transport.ts';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const MAX_MESSAGE = 256 * 1024 * 1024;

export const CLOSE = {
  normal: 1000,
  protocol: 1002,
  unsupported: 1003,
  invalid: 1007,
  tooBig: 1009,
  error: 1011,
} as const;

export const OP_TEXT = 1;
export const OP_BINARY = 2;

const OP = {
  continuation: 0,
  text: OP_TEXT,
  binary: OP_BINARY,
  close: 8,
  ping: 9,
  pong: 10,
} as const;

export interface Sink {
  write(bytes: Uint8Array, signal?: AbortSignal): Promise<unknown>;
}

export type WsEvent =
  | { kind: 'text'; text: string }
  | { kind: 'ping'; payload: Uint8Array }
  | { kind: 'close'; code: number; reason: string };

export type WsBinaryEvent = { kind: 'binary'; bytes: Uint8Array };

export class WsError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function sendableCode(code: number): boolean {
  if (code >= 3000 && code <= 4999) return true;
  return code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006;
}

function field(headers: HeaderList, name: string): string | undefined {
  return headers.find(([n]) => n.toLowerCase() === name)?.[1];
}

export async function acceptKey(headers: HeaderList): Promise<string> {
  const tokens = (name: string) =>
    (field(headers, name) ?? '').split(',').map((t) => t.trim().toLowerCase());
  if (!tokens('upgrade').includes('websocket') || !tokens('connection').includes('upgrade')) {
    throw new HttpError(400, 'expected a WebSocket upgrade');
  }
  if (field(headers, 'sec-websocket-version') !== '13') {
    throw new HttpError(400, 'Sec-WebSocket-Version must be 13');
  }
  const key = field(headers, 'sec-websocket-key') ?? '';
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) throw new HttpError(400, 'bad Sec-WebSocket-Key');
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(key + GUID));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

export function isUpgrade(headers: HeaderList): boolean {
  return (field(headers, 'upgrade') ?? '').toLowerCase().includes('websocket');
}

export function frame(opcode: number, payload: Uint8Array): Uint8Array {
  const n = payload.length;
  const size = n < 126 ? 2 : n < 0x10000 ? 4 : 10;
  const out = new Uint8Array(size + n);
  const view = new DataView(out.buffer);
  out[0] = 0x80 | opcode;
  if (n < 126) out[1] = n;
  else if (n < 0x10000) {
    out[1] = 126;
    view.setUint16(2, n);
  } else {
    out[1] = 127;
    view.setBigUint64(2, BigInt(n));
  }
  out.set(payload, size);
  return out;
}

export function closeFrame(code: number, reason = ''): Uint8Array {
  let bytes = new TextEncoder().encode(reason);
  if (bytes.length > 123) bytes = bytes.subarray(0, 123);
  const payload = new Uint8Array(2 + bytes.length);
  new DataView(payload.buffer).setUint16(0, code);
  payload.set(bytes, 2);
  return frame(OP.close, payload);
}

export function pongFrame(payload: Uint8Array): Uint8Array {
  return frame(OP.pong, payload);
}

async function fill(incoming: Incoming, out: Uint8Array, signal?: AbortSignal): Promise<void> {
  for (let at = 0; at < out.length; ) {
    const piece = await incoming.some(out.length - at, signal);
    if (piece.length === 0) throw new WsError(CLOSE.protocol, 'the connection closed mid-frame');
    out.set(piece, at);
    at += piece.length;
  }
}

const fatal = new TextDecoder('utf-8', { fatal: true });

function decode(bytes: Uint8Array): string {
  try {
    return fatal.decode(bytes);
  } catch {
    throw new WsError(CLOSE.invalid, 'a text message is not UTF-8');
  }
}

export class WsReader<Binary extends boolean = false> {
  private readonly incoming: Incoming;
  private readonly max: number;
  private parts: Uint8Array[] = [];
  private size = 0;
  private continuing = false;
  private binaryMessage = false;
  private readonly binary: Binary | undefined;

  constructor(incoming: Incoming, max = MAX_MESSAGE, binary?: Binary) {
    this.incoming = incoming;
    this.max = max;
    this.binary = binary;
  }

  async next(
    signal?: AbortSignal
  ): Promise<WsEvent | (Binary extends true ? WsBinaryEvent : never) | null> {
    for (;;) {
      const first = await this.incoming.some(1, signal);
      if (first.length === 0) return null;
      const head = new Uint8Array(2);
      head[0] = first[0];
      await fill(this.incoming, head.subarray(1), signal);
      const fin = (head[0] & 0x80) !== 0;
      const opcode = head[0] & 0x0f;
      if ((head[0] & 0x70) !== 0) throw new WsError(CLOSE.protocol, 'reserved bits are set');
      if ((head[1] & 0x80) === 0) throw new WsError(CLOSE.protocol, 'client frames must be masked');
      const length = await this.length(head[1] & 0x7f, signal);
      const control = opcode >= 8;
      if (control && (length > 125 || !fin)) {
        throw new WsError(CLOSE.protocol, 'a control frame is too long or fragmented');
      }
      if (!control && this.size + length > this.max) {
        throw new WsError(CLOSE.tooBig, `a message is over ${this.max} bytes`);
      }
      const mask = new Uint8Array(4);
      await fill(this.incoming, mask, signal);
      const payload = new Uint8Array(length);
      await fill(this.incoming, payload, signal);
      for (let i = 0; i < length; i++) payload[i] ^= mask[i & 3];
      const event = this.take(opcode, fin, payload);
      if (event) return event as WsEvent | (Binary extends true ? WsBinaryEvent : never);
    }
  }

  private data(
    opcode: number,
    fin: boolean,
    payload: Uint8Array
  ): WsEvent | WsBinaryEvent | undefined {
    if ((opcode === OP.continuation) !== this.continuing) {
      throw new WsError(CLOSE.protocol, 'unexpected continuation frame');
    }
    if (opcode !== OP.continuation) this.binaryMessage = opcode === OP.binary;
    this.parts.push(payload);
    this.size += payload.length;
    this.continuing = !fin;
    if (!fin) return undefined;
    const whole = this.parts.length === 1 ? payload : concat(this.parts, this.size);
    this.parts = [];
    this.size = 0;
    return this.binaryMessage
      ? { kind: 'binary', bytes: whole }
      : { kind: 'text', text: decode(whole) };
  }

  private async length(short: number, signal?: AbortSignal): Promise<number> {
    if (short < 126) return short;
    const ext = new Uint8Array(short === 126 ? 2 : 8);
    await fill(this.incoming, ext, signal);
    const view = new DataView(ext.buffer);
    if (short === 126) return view.getUint16(0);
    const long = view.getBigUint64(0);
    return long > BigInt(this.max) ? this.max + 1 : Number(long);
  }

  private take(
    opcode: number,
    fin: boolean,
    payload: Uint8Array
  ): WsEvent | WsBinaryEvent | undefined {
    switch (opcode) {
      case OP.ping:
        return { kind: 'ping', payload };
      case OP.pong:
        return undefined;
      case OP.close: {
        if (payload.length === 1) throw new WsError(CLOSE.protocol, 'a close frame is malformed');
        const code = payload.length >= 2 ? new DataView(payload.buffer).getUint16(0) : 1005;
        if (payload.length >= 2 && !sendableCode(code)) {
          throw new WsError(CLOSE.protocol, `close code ${code} may not be sent`);
        }
        return { kind: 'close', code, reason: decode(payload.subarray(2)) };
      }
      case OP.binary:
        if (!this.binary) throw new WsError(CLOSE.unsupported, 'CDP messages are text');
        return this.data(opcode, fin, payload);
      case OP.text:
      case OP.continuation:
        return this.data(opcode, fin, payload);
      default:
        throw new WsError(CLOSE.protocol, `unknown opcode ${opcode}`);
    }
  }
}

export function switchingHead(accept: string, protocol = ''): Uint8Array {
  const chosen = protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '';
  return latin1Bytes(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${chosen}\r\n`
  );
}
