export interface Received {
  bytes: Uint8Array;
  host: string;
  port: number;
  truncated: boolean;
  unix?: boolean;
}

export function encodeReceived(got: Received): Uint8Array {
  const host = new TextEncoder().encode(got.host);
  const out = new Uint8Array(4 + host.length + got.bytes.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, (got.truncated ? 1 : 0) | (got.unix ? 2 : 0));
  view.setUint16(1, got.port);
  view.setUint8(3, host.length);
  out.set(host, 4);
  out.set(got.bytes, 4 + host.length);
  return out;
}

export function decodeReceived(raw: Uint8Array): Received {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const length = view.getUint8(3);
  return {
    truncated: (view.getUint8(0) & 1) !== 0,
    unix: (view.getUint8(0) & 2) !== 0,
    port: view.getUint16(1),
    host: new TextDecoder().decode(raw.subarray(4, 4 + length)),
    bytes: raw.subarray(4 + length),
  };
}
