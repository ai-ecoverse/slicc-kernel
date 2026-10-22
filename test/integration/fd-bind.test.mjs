import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const READER = (dir, swap) =>
  [
    'import os, subprocess',
    `os.chdir('${dir}')`,
    "open('secret', 'w').write('SECRET-BYTES')",
    "open('racy', 'w').write('old')",
    "ino = os.stat('racy').st_ino",
    "fd = os.open('racy', os.O_RDWR)",
    swap,
    'got = os.read(fd, 64).decode()',
    "os.write(fd, b'+w')",
    'os.lseek(fd, 0, 0)',
    'again = os.read(fd, 64).decode()',
    "print(got, again, os.fstat(fd).st_ino == ino, open('secret').read(), os.readlink('racy'))",
    'os.close(fd)',
  ].join('\n');

const OWN = "os.symlink('secret', 'racy.l'); os.rename('racy.l', 'racy')";
const OTHER = (dir) =>
  `subprocess.run(['bash', '-c', 'cd ${dir} && ln -s secret racy.l && mv racy.l racy'], check=True)`;
const WANT = 'old old+w True SECRET-BYTES secret\n';

async function python(t) {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  return page;
}

const run = (tab, script) =>
  tab.evaluate((s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }), script);

test('an open file stays bound to the file it opened when the program itself renames a symlink over its name (#1394)', {
  timeout: 1_500_000,
}, async (t) => {
  const page = await python(t);
  await sh(page, 'rm -rf /root/b1 && mkdir -p /root/b1');
  assert.deepEqual(await run(page, READER('/root/b1', OWN)), ok(WANT));
});

test('an open file stays bound to the file it opened when another process renames a symlink over its name (#1394)', {
  timeout: 1_500_000,
}, async (t) => {
  const page = await python(t);
  await sh(page, 'rm -rf /root/b2 && mkdir -p /root/b2');
  assert.deepEqual(await run(page, READER('/root/b2', OTHER('/root/b2'))), ok(WANT));
});

test("an Emscripten program's open file stays bound to the file it opened when another process renames a symlink over its name (#1394)", {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  const r = await sh(
    page,
    [
      'rm -rf /root/b3 && mkdir -p /root/b3 && cd /root/b3',
      'echo SECRET-BYTES > secret; echo old > racy',
      '( exec 3< racy; until [ -e go ]; do :; done; cat <&3; : > done ) &',
      'ln -s secret racy.l && mv racy.l racy; : > go',
      'until [ -e done ]; do :; done; wait; readlink racy',
    ].join('\n')
  );
  assert.deepEqual(r, ok('old\nsecret\n'));
});

test('an open file stays bound to the file it opened when another tab renames a symlink over its name (#1394)', {
  timeout: 1_500_000,
}, async (t) => {
  const page = await python(t);
  const other = await peerTab(page);
  await sh(page, 'rm -rf /root/b4 && mkdir -p /root/b4');
  const swap = ["open('ready', 'w').close()", "while not os.path.exists('swapped'): pass"].join(
    '\n'
  );
  const reading = page.evaluate(
    (s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }),
    READER('/root/b4', swap)
  );
  for (let i = 0; ; i++) {
    const r = await sh(other, '[ -e /root/b4/ready ] && echo yes || echo no');
    if (r.stdout === 'yes\n') break;
    if (i % 100 === 99) {
      const early = await Promise.race([reading, 'running']);
      assert.equal(early, 'running', `the reader ended early: ${JSON.stringify(early)}`);
    }
  }
  assert.deepEqual(
    await sh(
      other,
      'cd /root/b4 && ln -s secret racy.l && mv racy.l racy && : > swapped && echo swapped'
    ),
    ok('swapped\n')
  );
  const read = await Promise.race([
    reading,
    new Promise((resolve) => setTimeout(() => resolve('no answer in 60 s'), 60_000)),
  ]);
  assert.equal(typeof read, 'object', String(read));
  assert.equal(
    read.stdout.includes('SECRET-BYTES SECRET') || read.stdout.startsWith('SECRET'),
    false,
    read.stdout
  );
  console.log(`another tab: ${JSON.stringify(read)}`);
  assert.ok(
    read.stdout === WANT || /ESTALE|Stale file handle|errno 70/.test(read.stderr),
    JSON.stringify(read)
  );
});

const PHASES = (dir) =>
  [
    'import os',
    `os.chdir('${dir}')`,
    "os.makedirs('d', exist_ok=True)",
    "open('secret', 'w').write('SECRET-BYTES')",
    "open('d/racy', 'w').write('old')",
    "fd = os.open('d/racy', os.O_RDONLY)",
    'out = []',
    'for phase in (1, 2):',
    "    open(f'ready{phase}', 'w').close()",
    "    while not os.path.exists(f'go{phase}'): pass",
    '    if phase == 1: continue',
    '    try:',
    '        out.append(os.pread(fd, 64, 0).decode())',
    '    except OSError as e:',
    '        out.append(f"errno {e.errno}")',
    "print(' '.join(out))",
  ].join('\n');

async function phased(page, other, dir, steps) {
  const reading = page.evaluate(
    (s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }),
    PHASES(dir)
  );
  for (const [phase, step] of steps.entries()) {
    for (let i = 0; ; i++) {
      const r = await sh(other, `[ -e ${dir}/ready${phase + 1} ] && echo yes || echo no`);
      if (r.stdout === 'yes\n') break;
      if (i % 100 === 99) {
        const early = await Promise.race([reading, 'running']);
        assert.equal(early, 'running', `the reader ended early: ${JSON.stringify(early)}`);
      }
    }
    assert.deepEqual(
      await sh(other, `cd ${dir} && ${step} && sleep 0.3 && : > go${phase + 1} && echo done`),
      ok('done\n')
    );
  }
  return Promise.race([
    reading,
    new Promise((resolve) => setTimeout(() => resolve({ stdout: 'no answer in 60 s' }), 60_000)),
  ]);
}

test('an open file another tab moved with its directory and then renamed something over is never read from that something (#1394 review)', {
  timeout: 1_500_000,
}, async (t) => {
  const page = await python(t);
  const other = await peerTab(page);
  await sh(page, 'rm -rf /root/b5 && mkdir -p /root/b5');
  const r = await phased(page, other, '/root/b5', [
    'mv d e',
    'ln -s secret e/racy.l && mv e/racy.l e/racy',
  ]);
  console.log(`moved then renamed over: ${JSON.stringify(r)}`);
  assert.equal(r.status, 0, JSON.stringify(r));
  assert.match(r.stdout, /^(old|errno 72)\n$/, r.stdout);
});
