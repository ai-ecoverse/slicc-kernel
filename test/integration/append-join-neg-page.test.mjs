import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const N = 200;
const appender = (tag) =>
  [
    'import os',
    "f = '/root/ap/log'",
    "while not os.path.exists('/root/ap/go'): pass",
    'fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)',
    'ok = 0',
    `for n in range(${N}):`,
    `    os.write(fd, b'${tag}%d\\n' % n); os.fsync(fd); ok += 1`,
    'os.close(fd)',
    'print(ok)',
  ].join('\n');

const JSAPP = [
  'mkdir -p /node_modules/jsapp',
  `echo '{"name":"jsapp","slicc":{"commands":{"jsapp":{"abi":"js","module":"main.mjs"}}}}' > /node_modules/jsapp/package.json`,
  "cat > /node_modules/jsapp/main.mjs <<'EOF'",
  'export default async function main(ctx) {',
  '  const [, tag, n, stamp] = ctx.argv;',
  "  while (!(await ctx.fs.exists('/root/ap/go'))) await new Promise((r) => setTimeout(r, 5));",
  "  const f = await ctx.open('/root/ap/log', { write: true, append: true, create: true });",
  '  let ok = 0;',
  '  const first = Date.now();',
  '  for (let i = 0; i < Number(n); i++) {',
  '    await f.write(0, new TextEncoder().encode(`${tag}${i}\\n`));',
  '    await f.sync();',
  '    ok++;',
  '  }',
  '  await f.close();',
  '  await ctx.write(1, stamp ? `${ok} ${first}\\n` : `${ok}\\n`);',
  '  return 0;',
  '}',
  'EOF',
  'echo installed',
].join('\n');

test('a tab that joins while another tab is slow writing back its appends keeps every record of both exactly once (#1546 guard)', {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t, { worker: '/slow-flush-worker.js?ms=20000&name=log' });
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await installPackage(page, 'wasm-coreutils');
  assert.deepEqual(
    await sh(page, 'rm -rf /root/ap && mkdir -p /root/ap && : > /root/ap/go && echo made'),
    ok('made\n')
  );
  assert.deepEqual(await sh(page, JSAPP), ok('installed\n'));
  const holder = [
    'import os, time',
    "fd = os.open('/root/ap/log', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)",
    'for n in range(200):',
    "    os.write(fd, b'x%d\\n' % n)",
    'start = time.time()',
    'while time.time() - start < 40: pass',
    'os.close(fd)',
    "print('held')",
  ].join('\n');
  await page.evaluate((s) => {
    window.holder = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, holder);
  await sleep(4000);
  const other = await peerTab(page, { wait: false });
  const y = await other.evaluate(() =>
    window.kernel.run(['jsapp', 'y', '50', 'stamp'], { cwd: '/' })
  );
  assert.equal(y.stdout.trim().split(' ')[0], '50', JSON.stringify(y));
  assert.equal((await page.evaluate(() => window.holder)).stdout, 'held\n');
  const counted = await page.evaluate(
    (s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }),
    "lines = open('/root/ap/log').read().splitlines(); print(len(set(l for l in lines if l.startswith('x'))), sum(l.startswith('x') for l in lines), sum(l.startswith('y') for l in lines), len(lines))"
  );
  assert.deepEqual(counted, ok('200 200 50 250\n'));
});

test('DO NOT MERGE: this diagnostic PR must never go green', () => {
  assert.fail('DO NOT MERGE');
});
