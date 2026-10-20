const KEYS = ['heapUsed', 'heapTotal', 'heapLimit', 'external', 'arrayBuffers'];
const held = [];
const grow = () => {
  for (let i = 0; i < 400_000; i++) held.push({ i, s: `item ${i}` });
};
export default async function main(ctx) {
  if (ctx.thread.tid !== 0) {
    const before = ctx.memory().heapUsed;
    grow();
    ctx.thread.port.postMessage({ before, after: ctx.memory().heapUsed });
    await new Promise(() => {});
  }
  const a = ctx.memory();
  const b = ctx.memory();
  const shape = {
    keys: Object.keys(a).filter((k) => !KEYS.includes(k)),
    numbers: Object.values(a).every((v) => typeof v === 'number'),
    plain: Object.getPrototypeOf(a) === Object.prototype,
    fresh: a !== b,
    rss: 'rss' in a,
    positive: ['heapUsed', 'heapTotal', 'heapLimit'].map((k) => a[k] > 0),
    process: typeof process,
    viaFunction: ctx.memory.constructor('return typeof process')(),
  };
  if (ctx.argv[1] === 'shape') {
    await ctx.write(1, JSON.stringify(shape));
    return 0;
  }
  const mainBefore = ctx.memory().heapUsed;
  const t = await ctx.thread.spawn({});
  const thread = await new Promise((resolve) => {
    t.port.onmessage = (e) => resolve(e.data);
  });
  const mainAfter = ctx.memory().heapUsed;
  await t.terminate();
  await ctx.write(
    1,
    JSON.stringify({
      threadGrew: thread.after - thread.before > 10_000_000,
      mainStill: mainAfter - mainBefore < 5_000_000,
      deltas: [thread.after - thread.before, mainAfter - mainBefore],
    })
  );
  return 0;
}
