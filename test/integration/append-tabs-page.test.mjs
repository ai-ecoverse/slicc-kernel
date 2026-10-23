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

test('O_APPEND writes from two tabs to one file all land, as two processes on one Linux file (#1520)', {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await installPackage(page, 'wasm-coreutils');
  const other = await peerTab(page);
  assert.deepEqual(
    await sh(page, 'rm -rf /root/ap && mkdir -p /root/ap && echo made'),
    ok('made\n')
  );
  for (const [tab, tag] of [
    [page, 'x'],
    [other, 'y'],
  ]) {
    await tab.evaluate(
      ([s, g]) => {
        window[`append_${g}`] = window.kernel.run(['python3', '-c', s], { cwd: '/' });
      },
      [appender(tag), tag]
    );
  }
  await sleep(2000);
  await sh(page, ': > /root/ap/go');
  const x = await page.evaluate(() => window.append_x);
  const y = await other.evaluate(() => window.append_y);
  assert.deepEqual([x.stdout, y.stdout], [`${N}\n`, `${N}\n`], JSON.stringify([x, y]));
  const counted = await page.evaluate(
    (s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }),
    "lines = open('/root/ap/log').read().splitlines(); print(sum(l.startswith('x') for l in lines), sum(l.startswith('y') for l in lines), len(lines))"
  );
  assert.deepEqual(counted, ok(`${N} ${N} ${2 * N}\n`));
});

const JSAPP = [
  'mkdir -p /node_modules/jsapp',
  `echo '{"name":"jsapp","slicc":{"commands":{"jsapp":{"abi":"js","module":"main.mjs"}}}}' > /node_modules/jsapp/package.json`,
  "cat > /node_modules/jsapp/main.mjs <<'EOF'",
  'export default async function main(ctx) {',
  '  const [, tag, n] = ctx.argv;',
  "  while (!(await ctx.fs.exists('/root/ap/go'))) await new Promise((r) => setTimeout(r, 5));",
  "  const f = await ctx.open('/root/ap/log', { write: true, append: true, create: true });",
  '  let ok = 0;',
  '  for (let i = 0; i < Number(n); i++) {',
  '    await f.write(0, new TextEncoder().encode(`${tag}${i}\\n`));',
  '    await f.sync();',
  '    ok++;',
  '  }',
  '  await f.close();',
  '  await ctx.write(1, `${ok}\\n`);',
  '  return 0;',
  '}',
  'EOF',
  'echo installed',
].join('\n');

test('O_APPEND writes from a JS program in one tab and a WASI program in another all land (#1520)', {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await installPackage(page, 'wasm-coreutils');
  const other = await peerTab(page);
  assert.deepEqual(await sh(other, JSAPP), ok('installed\n'));
  assert.deepEqual(
    await sh(page, 'rm -rf /root/ap && mkdir -p /root/ap && echo made'),
    ok('made\n')
  );
  await page.evaluate((s) => {
    window.append_x = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, appender('x'));
  await other.evaluate((n) => {
    window.append_y = window.kernel.run(['jsapp', 'y', String(n)], { cwd: '/' });
  }, N);
  await sleep(2000);
  await sh(page, ': > /root/ap/go');
  const x = await page.evaluate(() => window.append_x);
  const y = await other.evaluate(() => window.append_y);
  assert.deepEqual([x.stdout, y.stdout], [`${N}\n`, `${N}\n`], JSON.stringify([x, y]));
  const counted = await page.evaluate(
    (s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }),
    "lines = open('/root/ap/log').read().splitlines(); print(sum(l.startswith('x') for l in lines), sum(l.startswith('y') for l in lines), len(lines))"
  );
  assert.deepEqual(counted, ok(`${N} ${N} ${2 * N}\n`));
});

test('a tab appending while another tab truncates once and pwrites in the middle keeps every record after the truncation, with no hole (#1520)', {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await installPackage(page, 'wasm-coreutils');
  const other = await peerTab(page);
  assert.deepEqual(
    await sh(page, 'rm -rf /root/ap && mkdir -p /root/ap && : > /root/ap/log && echo made'),
    ok('made\n')
  );
  const cutter = [
    'import os, time',
    "while not os.path.exists('/root/ap/go'): pass",
    "fd = os.open('/root/ap/log', os.O_RDWR)",
    'time.sleep(0.3)',
    'os.ftruncate(fd, 0); os.fsync(fd)',
    'for _ in range(50):',
    '    head = os.pread(fd, 1, 0)',
    '    if head: os.pwrite(fd, head, 0); os.fsync(fd)',
    'os.close(fd)',
    "print('cut')",
  ].join('\n');
  await page.evaluate((s) => {
    window.append_x = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, appender('x'));
  await other.evaluate((s) => {
    window.cut = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, cutter);
  await sleep(2000);
  await sh(page, ': > /root/ap/go');
  const x = await page.evaluate(() => window.append_x);
  const cut = await other.evaluate(() => window.cut);
  assert.deepEqual([x.stdout, cut.stdout], [`${N}\n`, 'cut\n'], JSON.stringify([x, cut]));
  const check = [
    "data = open('/root/ap/log', 'rb').read()",
    "assert b'\\0' not in data, 'a hole'",
    'ns = [int(l[1:]) for l in data.decode().splitlines()]',
    `assert ns == list(range(ns[0], ${N})) if ns else True, ns[:5]`,
    "print('ok', len(ns))",
  ].join('\n');
  const checked = await page.evaluate(
    (s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }),
    check
  );
  assert.match(checked.stdout, /^ok \d+\n$/, JSON.stringify(checked));
});
