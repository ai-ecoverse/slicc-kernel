import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { hostfsProxy } from './hostfs-proxy.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const py = (lines) =>
  `python3 -c "$(echo ${Buffer.from(lines.join('\n')).toString('base64')} | base64 -d)"`;

async function mountedOverPort(t) {
  const stage = join(homedir(), 'Developer/ai-ecoverse/work/stage/hostfs-int');
  await mkdir(stage, { recursive: true });
  const dir = await mkdtemp(join(stage, 'loss-'));
  const proxy = await hostfsProxy({ folders: { project: dir } });
  t.after(async () => {
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  });
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await page.evaluate(
    (p) => {
      window.hostfsProxy = p;
      window.hostfsOverPort = true;
    },
    { url: proxy.url, key: proxy.key }
  );
  await bash('mkdir -p /mnt/p', { cwd: '/home' });
  const spec = { type: 'hostfs', source: 'project', target: '/mnt/p' };
  assert.equal((await page.evaluate((s) => window.kernel.mount(s), spec)).state, 'ok');
  const kill = () =>
    page.evaluate(() => {
      window.hostfsProxy = { url: 'http://127.0.0.1:9', key: 'gone' };
      window.dropHostfsPort();
    });
  const on = (name) =>
    stat(join(dir, name)).then(
      (s) => s.size,
      () => -1
    );
  return { dir, page, bash, kill, on };
}

async function until(check) {
  while (!(await check())) await new Promise((r) => setTimeout(r, 20));
}

const PYTHON = py([
  'import os',
  "fd = os.open('/mnt/p/w.txt', os.O_WRONLY | os.O_CREAT | os.O_TRUNC)",
  'failed = []',
  'for i in range(3000000):',
  '  try:',
  "    os.write(fd, b'line-%d\\n' % i)",
  '  except OSError:',
  "    failed.append('write')",
  '    break',
  'try:',
  '  os.close(fd)',
  'except OSError:',
  "  failed.append('close')",
  "print('python', *failed)",
]);

for (const [name, script, said] of [
  [
    'bash',
    'for i in $(seq 1 100000); do echo line-$i; done > /mnt/p/w.txt 2> /tmp/err; echo "bash $?"; read -r first < /tmp/err; echo "$first"',
    /^bash 1\nbash: line 1: echo: write error: No medium found\n$/,
  ],
  ['python', PYTHON, /^python (write )?close\n$/],
]) {
  test(`hostfs over a port: a ${name} writer whose port dies mid-write is told, and a fresh write after the loss fails too (#1062)`, {
    timeout: 600_000,
  }, async (t) => {
    const { bash, kill, on } = await mountedOverPort(t);
    const writer = bash(script, { cwd: '/home' });
    await until(async () => (await on('w.txt')) > 0);
    await kill();
    const r = await writer;
    assert.match(r.stdout, said, r.stderr.slice(0, 200));
    const fresh = await bash('echo data > /mnt/p/fresh.txt; echo "fresh $?"', { cwd: '/home' });
    assert.equal(fresh.stdout, 'fresh 1\n');
  });
}

test('hostfs over a port: what a program fsynced is on the host, and when the port dies before its close, fsync and close both fail (#1062)', {
  timeout: 600_000,
}, async (t) => {
  const { dir, bash, kill } = await mountedOverPort(t);
  const held = bash(
    py([
      'import os',
      "fd = os.open('/mnt/p/kept.txt', os.O_WRONLY | os.O_CREAT | os.O_TRUNC)",
      "os.write(fd, b'fsynced\\n')",
      'os.fsync(fd)',
      "open('/tmp/synced', 'w').close()",
      "os.write(fd, b'after\\n')",
      "while not os.path.exists('/tmp/gone'): pass",
      'out = []',
      'for name, call in (("fsync", lambda: os.fsync(fd)), ("close", lambda: os.close(fd))):',
      '  try:',
      '    call()',
      '    out.append(name + " 0")',
      '  except OSError as e:',
      '    out.append(name + " " + str(e.errno != 0))',
      'print(*out)',
    ]),
    { cwd: '/home' }
  );
  await until(async () => (await bash('[ -e /tmp/synced ]', { cwd: '/' })).status === 0);
  assert.equal(await readFile(join(dir, 'kept.txt'), 'utf8'), 'fsynced\n');
  await kill();
  await bash(': > /tmp/gone', { cwd: '/' });
  const h = await held;
  assert.equal(h.stdout, 'fsync True close True\n', h.stderr.slice(0, 400));
  assert.equal(await readFile(join(dir, 'kept.txt'), 'utf8'), 'fsynced\n');
});

test('hostfs over a live port: the same writers finish with 0 and every line on the host (#1062)', {
  timeout: 600_000,
}, async (t) => {
  const { dir, bash } = await mountedOverPort(t);
  const lines = 'i=0; while [ $i -lt 300000 ]; do echo line-$i; i=$((i+1)); done';
  const r = await bash(
    `${lines} > /mnt/p/w.txt; echo "bash $?"; ${lines} | cat > /mnt/p/c.txt; echo "cat $?"`,
    {
      cwd: '/home',
    }
  );
  assert.deepEqual(r, { status: 0, stdout: 'bash 0\ncat 0\n', stderr: '' });
  const want = Array.from({ length: 300000 }, (_, i) => `line-${i}\n`).join('');
  assert.equal(await readFile(join(dir, 'w.txt'), 'utf8'), want);
  assert.equal(await readFile(join(dir, 'c.txt'), 'utf8'), want);
});
