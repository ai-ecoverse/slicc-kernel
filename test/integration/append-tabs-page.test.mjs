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

test('a tab that joins while another holds buffered appends without a kernel call waits for them to land before its own, so no record is lost or doubled (#1546)', {
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
  await page.evaluate(() => {
    window.flushStamps = [];
    new BroadcastChannel('slow-flush').onmessage = ({ data }) => window.flushStamps.push(data);
  });
  await page.evaluate((s) => {
    window.holder = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, holder);
  await sleep(4000);
  const other = await peerTab(page, { wait: false });
  const y = await other.evaluate(() =>
    window.kernel.run(['jsapp', 'y', '50', 'stamp'], { cwd: '/' })
  );
  const [count, first] = y.stdout.trim().split(' ').map(Number);
  assert.equal(count, 50, JSON.stringify(y));
  let stamps = [];
  for (let i = 0; i < 600 && !stamps.some((s) => s.end); i++) {
    stamps = await page.evaluate(() => window.flushStamps);
    if (!stamps.some((s) => s.end)) await sleep(100);
  }
  const start = stamps.find((s) => s.start)?.start;
  const end = stamps.find((s) => s.end)?.end;
  console.log(`#1546 row: flush ${start}..${end}, the joiner's first append started at ${first}`);
  assert.ok(
    start < first && first < end,
    `the joiner's first append did not start inside the flush: ${JSON.stringify({ start, end, first })}`
  );
  assert.equal((await page.evaluate(() => window.holder)).stdout, 'held\n');
  const counted = await page.evaluate(
    (s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }),
    "lines = open('/root/ap/log').read().splitlines(); print(len(set(l for l in lines if l.startswith('x'))), sum(l.startswith('x') for l in lines), sum(l.startswith('y') for l in lines), len(lines))"
  );
  assert.deepEqual(counted, ok('200 200 50 250\n'));
});

test('a tab whose flushing peer dies before answering still appends, once that peer is gone (#1556, #1557)', {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t, { worker: '/slow-flush-worker.js?ms=600000' });
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await installPackage(page, 'wasm-coreutils');
  assert.deepEqual(
    await sh(
      page,
      'rm -rf /root/ap && mkdir -p /root/ap && : > /root/ap/go && echo a > /root/ap/log && echo made'
    ),
    ok('made\n')
  );
  const held = [
    'import os, time',
    "fd = os.open('/root/ap/log', os.O_WRONLY | os.O_APPEND)",
    "os.write(fd, b'x\\n')",
    'time.sleep(600)',
  ].join('\n');
  await page.evaluate((s) => {
    void window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, held);
  await sleep(2000);
  const other = await peerTab(page, { wait: false });
  assert.deepEqual(await sh(other, JSAPP), ok('installed\n'));
  await other.evaluate(() => {
    window.appending = window.kernel.run(['jsapp', 'y', '3'], { cwd: '/' });
  });
  await sleep(3000);
  await page.evaluate(() => window.kernel.terminate());
  const y = await Promise.race([
    other.evaluate(() => window.appending),
    sleep(60_000).then(() => 'stuck'),
  ]);
  assert.notEqual(y, 'stuck', 'the append never ran after its flushing peer died');
  assert.equal(y.stdout, '3\n', JSON.stringify(y));
});
