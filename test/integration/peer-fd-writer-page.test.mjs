import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const WRITER = [
  'import os, time',
  "os.chdir('/root/rc')",
  "open('f', 'w').write('old')",
  "fd = os.open('f', os.O_RDWR)",
  "open('ready', 'w').close()",
  'errs = {}; n = 0',
  'end = time.time() + 40',
  'while time.time() < end:',
  '    try:',
  "        os.pwrite(fd, b'x', 0); os.fsync(fd)",
  '    except OSError as e:',
  '        errs[e.errno] = errs.get(e.errno, 0) + 1',
  '    n += 1',
  "    if os.path.exists('stop'): break",
  'print(n, errs)',
].join('\n');

test("a program's writes through a descriptor follow another tab's plain moves of its file, 120 of them, with no errors (#1454, #1442)", {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  assert.equal(
    (await sh(page, 'rm -rf /root/rc && mkdir -p /root/rc && echo made')).stdout,
    'made\n'
  );
  await page.evaluate((script) => {
    window.writer = window.kernel.run(['python3', '-c', script], { cwd: '/' });
  }, WRITER);
  while (!(await page.evaluate(() => window.opfs.exists('root/rc/ready'))))
    await new Promise((resolve) => setTimeout(resolve, 20));
  const mover = await sh(
    other,
    'cd /root/rc && for i in $(seq 1 60); do mv f g; mv g f; done; : > stop; echo moved'
  );
  const writer = await page.evaluate(() => window.writer);
  console.log(`writer: ${writer.stdout.trim()} ${writer.stderr.trim()}`);
  console.log(`mover: ${JSON.stringify(mover)}`);
  assert.equal(mover.stdout, 'moved\n');
  assert.match(writer.stdout, /^\d+ \{\}\n$/, 'the writer saw errors');
});

test("a program's descriptor writes still fail as today when another tab really removes its file, with no rename to follow (#1442, #1423)", {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  assert.equal(
    (await sh(page, 'rm -rf /root/rc && mkdir -p /root/rc && echo made')).stdout,
    'made\n'
  );
  await page.evaluate(
    (script) => {
      window.writer = window.kernel.run(['python3', '-c', script], { cwd: '/' });
    },
    WRITER.replace('end = time.time() + 40', 'end = time.time() + 8')
  );
  while (!(await page.evaluate(() => window.opfs.exists('root/rc/ready'))))
    await new Promise((resolve) => setTimeout(resolve, 20));
  const mover = await sh(other, 'cd /root/rc && rm f && sleep 2 && : > stop; echo removed');
  const writer = await page.evaluate(() => window.writer);
  console.log(`removed baseline: writer ${writer.stdout.trim()} ${writer.stderr.trim()}`);
  console.log(`removed baseline: mover ${JSON.stringify(mover)}`);
  assert.equal(mover.stdout, 'removed\n');
  const [, errors] = /^\d+ (\{.*\})\n$/.exec(writer.stdout) ?? [];
  assert.ok(errors && errors !== '{}', writer.stdout);
  for (const [errno] of errors
    .slice(1, -1)
    .split(', ')
    .map((pair) => pair.split(': ')))
    assert.ok(['72', '44'].includes(errno), `only ESTALE and ENOENT, as on main: ${writer.stdout}`);
});

test("a program's descriptor writes never land in another file a peer renames over its name: the replacement always reads NEWNEW (#1454, data integrity)", {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  assert.equal(
    (await sh(page, 'rm -rf /root/rc && mkdir -p /root/rc && echo made')).stdout,
    'made\n'
  );
  await page.evaluate(
    (script) => {
      window.writer = window.kernel.run(['python3', '-c', script], { cwd: '/' });
    },
    WRITER.replace('end = time.time() + 40', 'end = time.time() + 30')
  );
  while (!(await page.evaluate(() => window.opfs.exists('root/rc/ready'))))
    await new Promise((resolve) => setTimeout(resolve, 20));
  const mover = await sh(
    other,
    'cd /root/rc && for i in $(seq 1 40); do printf NEWNEW > h; mv h f; sleep 0.05; [ "$(cat f)" = NEWNEW ] || echo "bad $i [$(cat f)]"; done; : > stop; echo replaced'
  );
  const writer = await page.evaluate(() => window.writer);
  console.log(`replaced: writer ${writer.stdout.trim()}`);
  assert.equal(
    mover.stdout,
    'replaced\n',
    `the replacement took the writer's bytes: ${mover.stdout}`
  );
  assert.equal((await sh(page, 'cat /root/rc/f')).stdout, 'NEWNEW');
});

test('a file the open created and wrote through its descriptor keeps working, and a write-back never creates its name again after a peer removes it (#1454)', {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  assert.equal(
    (await sh(page, 'rm -rf /root/rn && mkdir -p /root/rn && echo made')).stdout,
    'made\n'
  );
  const script = [
    'import os, time',
    "os.chdir('/root/rn')",
    "fd = os.open('n', os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o644)",
    "os.write(fd, b'made'); os.fsync(fd)",
    "open('ready', 'w').close()",
    "while not os.path.exists('gone'): time.sleep(0.01)",
    'try:',
    "    os.pwrite(fd, b'late', 0); os.fsync(fd); print('wrote')",
    'except OSError as e:',
    "    print('refused', e.errno)",
    "print(os.path.exists('n'))",
  ].join('\n');
  await page.evaluate((s) => {
    window.creator = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, script);
  while (!(await page.evaluate(() => window.opfs.exists('root/rn/ready'))))
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    (await sh(other, 'cd /root/rn && cat n && rm n && : > gone && echo removed')).stdout,
    'maderemoved\n'
  );
  const creator = await page.evaluate(() => window.creator);
  assert.equal(creator.stdout.trim().split('\n').at(-1), 'False', creator.stdout);
});

test("a program's descriptor writes never land in a new file a peer makes at its name after removing the old one: the new file always reads NEWNEW (#1454, data integrity)", {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  assert.equal(
    (await sh(page, 'rm -rf /root/rc && mkdir -p /root/rc && echo made')).stdout,
    'made\n'
  );
  await page.evaluate(
    (script) => {
      window.writer = window.kernel.run(['python3', '-c', script], { cwd: '/' });
    },
    WRITER.replace('end = time.time() + 40', 'end = time.time() + 30')
  );
  while (!(await page.evaluate(() => window.opfs.exists('root/rc/ready'))))
    await new Promise((resolve) => setTimeout(resolve, 20));
  const mover = await sh(
    other,
    'cd /root/rc && for i in $(seq 1 40); do rm -f f; printf NEWNEW > f; sleep 0.05; [ "$(cat f)" = NEWNEW ] || echo "bad $i [$(cat f)]"; done; : > stop; echo remade'
  );
  const writer = await page.evaluate(() => window.writer);
  console.log(`remade: writer ${writer.stdout.trim()}`);
  assert.equal(mover.stdout, 'remade\n', `the new file took the writer's bytes: ${mover.stdout}`);
  assert.equal((await sh(page, 'cat /root/rc/f')).stdout, 'NEWNEW');
});
