export function fresh(bytes: Uint8Array, start = 0, end = bytes.length): Uint8Array {
  return new Uint8Array(bytes.subarray(start, end));
}
