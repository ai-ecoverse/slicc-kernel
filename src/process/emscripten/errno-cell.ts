import type { EmContext } from './context.ts';

const ENOMEM = 48;
const IMPOSSIBLE = 0xc0000000;

export class ErrnoCell {
  private at: number | undefined;
  private readonly ctx: EmContext;

  constructor(ctx: EmContext) {
    this.ctx = ctx;
  }

  private find(): number | undefined {
    const malloc = this.ctx.exports().malloc;
    if (typeof malloc !== 'function') return undefined;
    const before = new Int32Array(this.ctx.mem.bytes(0, this.ctx.mem.size()).slice().buffer);
    const got = malloc(IMPOSSIBLE);
    if (got !== 0) {
      this.ctx.exports().free?.(got);
      return undefined;
    }
    const after = new Int32Array(this.ctx.exports().memory.buffer, 0, before.length);
    let found: number | undefined;
    for (let i = 0; i < before.length; i++) {
      if (after[i] !== ENOMEM || before[i] === ENOMEM) continue;
      if (found !== undefined) return undefined;
      found = i * 4;
    }
    return found;
  }

  set(errno: number): boolean {
    this.at ??= this.find();
    if (this.at === undefined) return false;
    this.ctx.mem.view().setInt32(this.at, errno, true);
    return true;
  }
}
