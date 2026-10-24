const enc = new TextEncoder();
const dec = new TextDecoder();

async function seen(ctx, path) {
  const { sync } = ctx;
  const f = sync.open(path, { read: true, write: true, create: true, truncate: true });
  const before = sync.fs.stat(path).mtimeMs;
  const at = Date.now();
  while (Date.now() < at + 5) {}
  f.write(0, enc.encode('hello'));
  const after = sync.fs.stat(path).mtimeMs;
  const first = [sync.fs.stat(path).size, dec.decode(sync.fs.readFile(path)), after > before];
  f.write(5, enc.encode(' world'));
  const second = [(await ctx.fs.stat(path)).size, dec.decode(await ctx.fs.readFile(path))];
  f.write(11, enc.encode('!'));
  const third = [sync.fs.lstat(path).size, (await ctx.fs.lstat(path)).size];
  f.close();
  return { first, second, third };
}

export default async function main(ctx) {
  if (ctx.thread.tid !== 0) {
    ctx.thread.port.postMessage(await seen(ctx, ctx.thread.data.path));
    await new Promise(() => {});
  }
  const main = await seen(ctx, '/tmp/flush-main');
  const t = await ctx.thread.spawn({ data: { path: '/tmp/flush-thread' } });
  const thread = await new Promise((resolve) => {
    t.port.onmessage = (e) => resolve(e.data);
  });
  await t.terminate();
  await ctx.write(1, enc.encode(`${JSON.stringify({ main, thread })}\n`));
}
