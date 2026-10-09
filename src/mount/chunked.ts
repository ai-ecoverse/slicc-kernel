export const CHUNK = 1024 * 1024;

export class ChunkedBytes {
  private chunks: Array<Uint8Array | undefined> = [];
  size = 0;

  read(offset: number, length: number): Uint8Array {
    const end = Math.min(this.size, offset + length);
    if (end <= offset) return new Uint8Array(0);
    const out = new Uint8Array(end - offset);
    for (let at = offset; at < end; ) {
      const index = Math.floor(at / CHUNK);
      const from = at - index * CHUNK;
      const n = Math.min(CHUNK - from, end - at);
      const chunk = this.chunks[index];
      if (chunk) out.set(chunk.subarray(from, Math.min(from + n, chunk.length)), at - offset);
      at += n;
    }
    return out;
  }

  write(offset: number, bytes: Uint8Array, owned = false): void {
    const whole = owned && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    for (let done = 0; done < bytes.length; ) {
      const at = offset + done;
      const index = Math.floor(at / CHUNK);
      const from = at - index * CHUNK;
      const n = Math.min(CHUNK - from, bytes.length - done);
      if (whole && n === CHUNK && bytes.length === CHUNK) this.chunks[index] = bytes;
      else this.room(index, from + n).set(bytes.subarray(done, done + n), from);
      done += n;
    }
    this.size = Math.max(this.size, offset + bytes.length);
  }

  truncate(size: number): void {
    if (size < this.size) {
      const keep = Math.ceil(size / CHUNK);
      this.chunks.length = Math.min(this.chunks.length, keep);
      const tail = this.chunks[keep - 1];
      const from = size - (keep - 1) * CHUNK;
      if (tail && from < tail.length) tail.fill(0, from);
    }
    this.size = size;
  }

  private room(index: number, need: number): Uint8Array {
    const chunk = this.chunks[index];
    if (chunk && chunk.length >= need) return chunk;
    const grown = new Uint8Array(Math.min(CHUNK, Math.max(need, (chunk?.length ?? 0) * 2)));
    if (chunk) grown.set(chunk);
    this.chunks[index] = grown;
    return grown;
  }
}
