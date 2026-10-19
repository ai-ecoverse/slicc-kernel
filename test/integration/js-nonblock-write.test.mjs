import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PROGRAM = `export default async function main(ctx) {
  const out = [];
  const say = (s) => out.push(s);
  const code = (f) => f.then((n) => 'n=' + n, (e) => e.code);
  const syncCode = (f) => { try { return 'n=' + f(); } catch (e) { return e.code; } };
  const fill = async (fd) => {
    let total = 0;
    for (;;) {
      try { total += await ctx.write(fd, new Uint8Array(4096), { nonblock: true }); }
      catch (e) { if (e.code === 'EAGAIN') return total; throw e; }
    }
  };
  for (const kind of ['socketpair', 'pipe']) {
    const [r, w] = kind === 'socketpair' ? await ctx.socketpair() : await ctx.pipe();
    const first = await ctx.write(w, 'a', { nonblock: true });
    if (first !== 1) {
      await ctx.write(1, 'a nonblock write returned ' + first + '\\n');
      return;
    }
    const filled = 1 + (await fill(w));
    say(kind + ' filled ' + (filled > 0));
    say(kind + ' async ' + (await code(ctx.write(w, 'x', { nonblock: true }))));
    say(kind + ' sync ' + syncCode(() => ctx.sync.write(w, 'x', { nonblock: true })));
    const before = await ctx.select({ write: [w], timeoutMs: 0 });
    say(kind + ' writable full ' + before.write.length);
    const waiting = ctx.select({ write: [w] });
    let drained = 0;
    while (drained < 6000) drained += (await ctx.read(r, 65536)).length;
    say(kind + ' writable after read ' + ((await waiting).write.join(',') === String(w)));
    const big = new Uint8Array(filled + 65536);
    const part = await ctx.write(w, big, { nonblock: true });
    say(kind + ' partial ' + (part > 0 && part < big.length));
    say(kind + ' sync after ' + syncCode(() => ctx.sync.write(w, 'y', { nonblock: true })));
    await ctx.close(r);
    await ctx.close(w);
  }
  const f = await ctx.open('/tmp/nb', { write: true, create: true, truncate: true });
  say('file async ' + (await ctx.write(f.fd, new Uint8Array(100000), { nonblock: true })));
  say('file sync ' + ctx.sync.write(f.fd, new Uint8Array(70000), { nonblock: true }));
  say('file size ' + (await f.size()));
  await f.close();
  const [, w2] = await ctx.pipe();
  say('blocking returns ' + (await ctx.write(w2, 'abc')) + ' ' + ctx.sync.write(w2, 'de'));
  await ctx.write(1, out.join('\\n') + '\\n');
}
`;

test('a nonblock write takes what fits or is EAGAIN at once, on a socketpair and a pipe; select reports writable when room returns; a regular file ignores it (#1124)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/nbw/package.json',
    JSON.stringify({ name: 'nbw', slicc: { commands: { nbw: { abi: 'js', module: 'nbw.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/nbw/nbw.mjs', PROGRAM);
  const r = await kernel.run(['nbw'], { cwd: '/' });
  assert.equal(r.stderr, '');
  assert.equal(
    r.stdout,
    [
      'socketpair filled true',
      'socketpair async EAGAIN',
      'socketpair sync EAGAIN',
      'socketpair writable full 0',
      'socketpair writable after read true',
      'socketpair partial true',
      'socketpair sync after EAGAIN',
      'pipe filled true',
      'pipe async EAGAIN',
      'pipe sync EAGAIN',
      'pipe writable full 0',
      'pipe writable after read true',
      'pipe partial true',
      'pipe sync after EAGAIN',
      'file async 100000',
      'file sync 70000',
      'file size 170000',
      'blocking returns 3 2',
      '',
    ].join('\n')
  );
});
