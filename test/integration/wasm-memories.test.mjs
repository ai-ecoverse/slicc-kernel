import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const together = (page, argv, n) =>
  page.run(
    { maxMs: 300_000 },
    (a, k) => Promise.all(Array.from({ length: k }, () => window.kernel.run(a, { cwd: '/tmp' }))),
    argv,
    n
  );

test('more live processes than V8 has room for wait their turn instead of failing with a RangeError (#970)', {
  timeout: 400_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t);
  const sleeps = await together(page, ['sleep', '2'], 150);
  assert.deepEqual(
    sleeps.filter((r) => r.status !== 0 || r.stderr !== ''),
    [],
    'every one of 150 concurrent sleeps exits 0'
  );
  const pipes = await together(
    page,
    ['bash', '-c', "head -c 60000 /dev/zero | tr '\\0' x | wc -c"],
    20
  );
  assert.deepEqual(
    pipes.map((r) => r.stdout),
    Array(20).fill('60000\n')
  );
  const shown = await bash('cat /proc/sys/kernel/slicc_wasm_memories');
  assert.match(shown.stdout, /^\d+ \d+ (default|learned)\n$/);
  assert.ok(Number(shown.stdout.split(' ')[1]) > 0, `a ceiling is known: ${shown.stdout}`);
});

const THREADS = `const live = (ctx) => Number(new TextDecoder().decode(ctx.sync.fs.readFile('/proc/sys/kernel/slicc_wasm_memories')).split(' ')[0]);
export default async function main(ctx) {
  if (ctx.thread.tid !== 0) await new Promise(() => {});
  const before = live(ctx);
  const one = await ctx.thread.spawn({});
  const withOne = live(ctx);
  const pool = [];
  for (let i = 0; i < 15; i++) pool.push(await ctx.thread.spawn({}));
  const withSixteen = live(ctx);
  for (const t of [one, ...pool]) await t.terminate();
  await new Promise((r) => setTimeout(r, 50));
  await ctx.write(1, JSON.stringify({ one: withOne - before, sixteen: withSixteen - before, after: live(ctx) - before }));
  return 0;
}
`;

test('in the page each live JS thread takes one slot in /proc/sys/kernel/slicc_wasm_memories, a 16-thread pool 16, and they come back when the threads end (#1133)', async (t) => {
  const { page } = await booted(chrome, t);
  await page.evaluate(async (program) => {
    await window.opfs.write(
      'node_modules/threads/package.json',
      JSON.stringify({
        name: 'threads',
        slicc: { commands: { threads: { abi: 'js', module: 'main.mjs' } } },
      })
    );
    await window.opfs.write('node_modules/threads/main.mjs', program);
  }, THREADS);
  const r = await page.run({ maxMs: 120_000 }, () => window.kernel.run(['threads'], { cwd: '/' }));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { one: 1, sixteen: 16, after: 0 });
});
