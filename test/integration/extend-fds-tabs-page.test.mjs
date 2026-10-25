import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const N = 40;
const BLIND = 'blind-worker.js?path=%2Froot%2Fap%2Flog';
const ab = (base, w) => `/${base ? 'ab-' : ''}${w}`;
const verdict = (base, got, want, what) => {
  const lines = got.split('\n').filter(Boolean);
  console.log(
    `AB ${base ? 'main' : 'head'} ${what}: ${got === want ? 'keeps every record' : `loses: ${lines.length} lines, ${lines.filter((l) => l[0] === 'x').length} x`}`
  );
  if (base) assert.notEqual(got, want);
  else assert.equal(got, want);
};
const turn = (n) => `'/root/ap/t%d' % (${n})`;
const appender = [
  'import os',
  "fd = os.open('/root/ap/log', os.O_WRONLY | os.O_APPEND)",
  "open('/root/ap/held-x', 'w').close()",
  `for i in range(${N}):`,
  `    while not os.path.exists(${turn('2 * i')}): pass`,
  "    os.write(fd, b'x%d\\n' % i)",
  `    open(${turn('2 * i + 1')}, 'w').close()`,
  'os.close(fd)',
  "print('x done')",
].join('\n');
const seeker = (open) =>
  [
    'import os',
    "while not os.path.exists('/root/ap/held-x'): pass",
    open,
    `open(${turn(0)}, 'w').close()`,
    `for i in range(${N}):`,
    `    while not os.path.exists(${turn('2 * i + 1')}): pass`,
    '    os.lseek(fd, 0, os.SEEK_END)',
    "    os.write(fd, b'y%d\\n' % i)",
    `    open(${turn('2 * i + 2')}, 'w').close()`,
    "print('y done')",
  ].join('\n');
const inherited = [
  'import stat',
  'def regular(f):',
  '    try:',
  '        return stat.S_ISREG(os.fstat(f).st_mode)',
  '    except OSError:',
  '        return False',
  'fd = next(f for f in range(3, 64) if regular(f))',
].join('\n');
const JS_SEEKER = `export default async (ctx) => {
  const fs = ctx.sync.fs;
  const n = Number(ctx.argv[1]);
  const path = ctx.argv[2];
  const wait = ctx.argv[3] === 'wait';
  while (wait && !fs.exists('/root/ap/held-x'));
  const f = ctx.sync.open(path, { write: true });
  const enc = new TextEncoder();
  if (wait) fs.writeFile('/root/ap/t0', '');
  for (let i = 0; i < n; i++) {
    while (wait && !fs.exists('/root/ap/t' + (2 * i + 1)));
    f.write(f.size(), enc.encode((wait ? 'y' : 'z') + i + '\\n'));
    if (wait) fs.writeFile('/root/ap/t' + (2 * i + 2), '');
  }
  f.close();
  await ctx.write(1, wait ? 'y done\\n' : String(fs.stat(path).size) + '\\n');
  return 0;
};`;

async function installJsSeeker(page) {
  await page.evaluate(async (m) => {
    const pkg = {
      name: 'seekend',
      slicc: { commands: { seekend: { abi: 'js', module: 'main.mjs' } } },
    };
    await window.opfs.write('node_modules/seekend/package.json', JSON.stringify(pkg));
    await window.opfs.write('node_modules/seekend/main.mjs', m);
  }, JS_SEEKER);
}

async function twoTabs(t, worker) {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await installPackage(page, 'wasm-coreutils');
  await installJsSeeker(page);
  const other = await peerTab(page, { worker });
  return { page, other };
}

async function takingTurns(page, other, argv, base, what) {
  await page.evaluate((s) => {
    window.extend_x = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, appender);
  await other.evaluate((a) => {
    window.extend_y = window.kernel.run(a, { cwd: '/' });
  }, argv);
  const x = await page.evaluate(() => window.extend_x);
  const y = await other.evaluate(() => window.extend_y);
  assert.deepEqual([x.stdout, y.stdout], ['x done\n', 'y done\n'], JSON.stringify([x, y]));
  const want = Array.from({ length: N }, (_, i) => `x${i}\ny${i}\n`).join('');
  verdict(base, (await sh(page, 'cat /root/ap/log')).stdout, want, what);
}

const fresh = 'rm -rf /root/ap && mkdir -p /root/ap && : > /root/ap/log && echo made';

for (const base of [true, false])
  for (const { kind, argv } of [
    { kind: 'a JS ctx.sync.open', argv: ['seekend', String(N), '/root/ap/log', 'wait'] },
    {
      kind: 'a shell exec 3<> fd',
      argv: ['bash', '-c', 'exec 3<>/root/ap/log; python3 -c "$1"', 'bash', seeker(inherited)],
    },
  ]) {
    test(`${base ? 'MAIN' : 'HEAD'} SEEK_END writes through ${kind} taking turns with another tab's O_APPEND keep every record, unseen appends too (#1675)`, {
      timeout: 600_000,
    }, async (t) => {
      const { page, other } = await twoTabs(t, ab(base, BLIND));
      assert.deepEqual(await sh(page, fresh), ok('made\n'));
      await takingTurns(page, other, argv, base, kind);
    });
  }

const T = 10;
const step = (k) => `'/root/ap/${k}%d' % i`;
const lateAppender = [
  'import os, time',
  "fd = os.open('/root/ap/log', os.O_WRONLY | os.O_APPEND)",
  "open('/root/ap/held-x', 'w').close()",
  `for i in range(${T}):`,
  `    while not os.path.exists(${step('a')}): pass`,
  '    time.sleep(0.2)',
  "    os.write(fd, b'x%d\\n' % i)",
  `    while not os.path.exists(${step('b')}): pass`,
  `    open(${step('c')}, 'w').close()`,
  'os.close(fd)',
  "print('x done')",
].join('\n');
const linkWriter = [
  'import os, time',
  "while not os.path.exists('/root/ap/held-x'): pass",
  "fd = os.open('/root/ap/link', os.O_WRONLY)",
  `for i in range(${T}):`,
  `    open(${step('a')}, 'w').close()`,
  '    os.lseek(fd, 0, os.SEEK_END)',
  "    os.write(fd, b'y%d\\n' % i)",
  '    end = time.monotonic() + 0.6',
  '    while time.monotonic() < end: pass',
  `    open(${step('b')}, 'w').close()`,
  `    while not os.path.exists(${step('c')}): pass`,
  "print('y done')",
].join('\n');

for (const base of [true, false])
  test(`${base ? 'MAIN' : 'HEAD'} a WASI write past the end through a symlink is in the file before another tab's O_APPEND lands, as on Linux (#1675)`, {
    timeout: 600_000,
  }, async (t) => {
    const { page, other } = await twoTabs(t, ab(base, BLIND));
    assert.deepEqual(await sh(page, `${fresh} && ln -s log /root/ap/link`), ok('made\n'));
    await page.evaluate((s) => {
      window.late_x = window.kernel.run(['python3', '-c', s], { cwd: '/' });
    }, lateAppender);
    await other.evaluate((s) => {
      window.link_y = window.kernel.run(['python3', '-c', s], { cwd: '/' });
    }, linkWriter);
    const x = await page.evaluate(() => window.late_x);
    const y = await other.evaluate(() => window.link_y);
    assert.deepEqual([x.stdout, y.stdout], ['x done\n', 'y done\n'], JSON.stringify([x, y]));
    const want = Array.from({ length: T }, (_, i) => `y${i}\nx${i}\n`).join('');
    verdict(base, (await sh(page, 'cat /root/ap/log')).stdout, want, 'symlink');
  });

const counted = (tab) =>
  tab.evaluate(
    () =>
      new Promise((resolve) => {
        const c = new BroadcastChannel('lock-count');
        c.onmessage = ({ data }) => {
          c.close();
          resolve(data);
        };
        c.postMessage('?');
      })
  );
const opfsOps = async (tab) =>
  Number((await sh(tab, 'cat /proc/sys/kernel/slicc_opfs_ops')).stdout);
const solo = [
  'import os',
  inherited,
  'for i in range(200):',
  '    os.lseek(fd, 0, os.SEEK_END)',
  "    os.write(fd, b'z%d\\n' % i)",
  "print(os.path.getsize('/root/ap/solo'))",
].join('\n');

for (const base of [true, false])
  for (const { kind, argv } of [
    { kind: 'a JS ctx.sync.open', argv: ['seekend', '200', '/root/ap/solo', 'solo'] },
    {
      kind: 'a shell exec 3<> fd',
      argv: ['bash', '-c', 'exec 3<>/root/ap/solo; python3 -c "$1"', 'bash', solo],
    },
  ]) {
    test(`${base ? 'MAIN' : 'HEAD'} SEEK_END writes through ${kind} to a file no other tab holds take no append lock (#1675)`, {
      timeout: 600_000,
    }, async (t) => {
      const { other } = await twoTabs(t, ab(base, 'lock-count-worker.js'));
      for (let rep = 0; rep < 4; rep++) {
        assert.deepEqual(
          await sh(other, 'rm -rf /root/ap && mkdir -p /root/ap && : > /root/ap/solo && echo made'),
          ok('made\n')
        );
        const [c0, ops0] = [await counted(other), await opfsOps(other)];
        const r = await other.evaluate((a) => window.kernel.run(a, { cwd: '/' }), argv);
        const [c1, ops1] = [await counted(other), await opfsOps(other)];
        console.log(
          `AB ${base ? 'main' : 'head'} #1675 uncrowded, ${kind}, rep ${rep}: append locks ${c1.taken - c0.taken}, opfs ops ${ops1 - ops0}`
        );
        assert.deepEqual(r, ok('890\n'));
        assert.equal(c1.taken - c0.taken, 0);
      }
    });
  }
