import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const ROUNDS = Number(process.env.RMDIR_HELD_ROUNDS ?? 450);
const HOGS = Number(process.env.RMDIR_HELD_HOGS ?? 4);

test('on the OPFS root, files opened inside a directory that another process keeps removing and replacing read as a full version every time, never empty (#1013)', {
  timeout: 900_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  await installPackage(page, 'wasm-coreutils');
  const made = await bash(
    'mkdir -p /root/rd/d && echo v0 > /root/rd/d/a && echo v0 > /root/rd/d/b && : > /root/rd/err',
    { cwd: '/' }
  );
  assert.equal(made.status, 0, made.stderr);
  const pkg = JSON.stringify({
    name: 'rdrm',
    slicc: { commands: { rdrm: { abi: 'js', module: 'main.mjs' } } },
  });
  const main = [
    'export default async function main(ctx) {',
    '  const rounds = Number(ctx.argv[1]);',
    '  for (let i = 1; i <= rounds; i++) {',
    "    await ctx.fs.mkdir('/root/rd/n');",
    "    await ctx.fs.writeFile('/root/rd/n/a', `v${i}\\n`);",
    "    await ctx.fs.writeFile('/root/rd/n/b', `v${i}\\n`);",
    "    await ctx.fs.rm('/root/rd/d');",
    "    await ctx.fs.rename('/root/rd/n', '/root/rd/d');",
    "    await ctx.fs.writeFile('/root/rd/round', String(i));",
    '  }',
    "  await ctx.fs.writeFile('/root/rd/stop', '');",
    '  return 0;',
    '}',
  ].join('\n');
  await page.evaluate(
    async (p, m) => {
      await window.opfs.write('node_modules/rdrm/package.json', p);
      await window.opfs.write('node_modules/rdrm/main.mjs', m);
    },
    pkg,
    main
  );
  const script = [
    'cd /root/rd',
    '(while [ ! -e stop ]; do cat d/a > /dev/null 2>&1; done) &',
    'for r in 1 2 3 4 5 6 7 8; do (while [ ! -e stop ]; do { sleep 0.005; read -r v <&3 2> /tmp/rd.$r; rc=$?; case "$v" in v[0-9]*) ;; *) echo "bad [$v] rc=$rc round=$(cat round 2> /dev/null) $(cat /tmp/rd.$r)" >> err;; esac; } 3< d/b; done 2> /dev/null) & done',
    `rdrm ${ROUNDS}`,
    'echo "rdrm $?"',
    'wait',
    'echo done',
  ].join('\n');
  await page.evaluate((n) => {
    const spin = 'const end = Date.now() + 600000; while (Date.now() < end);';
    const url = URL.createObjectURL(new Blob([spin]));
    window.hogs = Array.from({ length: n }, () => new Worker(url));
  }, HOGS);
  const outcome = await page.run(
    {
      marker: () => window.__rdRound,
      quietMs: 120_000,
      maxMs: 800_000,
      label: 'the directory removals',
    },
    async (s) => {
      const poll = setInterval(async () => {
        window.__rdRound = await window.opfs.read('root/rd/round');
      }, 500);
      const r = await window.kernel.run(['bash', '-c', s], { cwd: '/' });
      clearInterval(poll);
      return r.stdout + r.stderr;
    },
    script
  );
  await page.evaluate(() => {
    for (const hog of window.hogs) hog.terminate();
  });
  assert.equal(outcome, 'rdrm 0\ndone\n');
  const err = await bash('cat /root/rd/err', { cwd: '/' });
  assert.equal(err.stdout, '', `reads that weren't a full version:\n${err.stdout.slice(0, 2000)}`);
});
