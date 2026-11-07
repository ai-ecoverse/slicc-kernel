import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const CHUNK = 65536;
export const TOTAL = 256 * 1024 * 1024;
export const READ = 1024 * 1024;
export const AHEAD = 2 * CHUNK;

function stall(pulls) {
  let gap = 0;
  let held = 0;
  for (let i = 1; i < pulls.length; i++) {
    const at = pulls[i][0] - pulls[i - 1][0];
    if (at > gap) [gap, held] = [at, pulls[i - 1][1]];
  }
  return { gap, held };
}

export function digest(from, to) {
  const hash = createHash('md5');
  for (let at = from; at < to; at += CHUNK)
    hash.update(new Uint8Array(CHUNK).fill((at / CHUNK) % 251));
  return hash.digest('hex');
}

export const FLOW = `export default async function main(ctx) {
  const file = await ctx.open('/dev/embedder', { read: true, write: true });
  await file.write(0, new TextEncoder().encode('{"kind":"test.flow"}\\n'));
  let at = 0;
  let wrong = 0;
  const take = async (limit) => {
    while (at < limit) {
      const bytes = await file.read(0, Math.min(${CHUNK}, limit - at));
      if (bytes.length === 0) return;
      for (let i = 0; i < bytes.length; i++) if (bytes[i] !== Math.floor((at + i) / ${CHUNK}) % 251) wrong++;
      at += bytes.length;
    }
  };
  await take(${READ});
  if (ctx.argv[1] === 'close') {
    await file.close();
    await ctx.write(1, at + '\\n');
    return 0;
  }
  await new Promise((r) => setTimeout(r, 2000));
  await take(Infinity);
  await ctx.write(1, at + ' ' + wrong + '\\n');
  return 0;
}
`;

export const FLOW_SH = `exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"test.flow"}' >&3; head -c ${READ} <&3 | md5sum; sleep 2; cat <&3 | md5sum`;
export const FLOW_CLOSE_SH = `exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"test.flow"}' >&3; head -c ${READ} <&3 | wc -c; exec 3<&-; echo closed`;

export function heldBack(state, what) {
  const { gap, held } = stall(state.pulls);
  assert.ok(gap >= 1500, `${what}: the page never waited (${gap} ms)`);
  assert.ok(held >= READ && held <= READ + AHEAD, `${what}: ${held} bytes made while paused`);
}
