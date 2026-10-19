import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const CAP = 3_000_000;
const GATE_DIRS = 6;
const GATE_RATIO = 1.5;

const py = (lines) =>
  `python3 -c "$(echo ${Buffer.from(['import fcntl, os, sys', ...lines].join('\n')).toString('base64')} | base64 -d)"`;

const held = (name) => [`while not os.path.exists('${name}'): pass`];
const listed = (name) => {
  const at = name.lastIndexOf('/');
  return [`while '${name.slice(at + 1)}' not in os.listdir('${name.slice(0, at)}'): pass`];
};

const calls = async (sh) =>
  Number((await sh('read -r n < /proc/sys/kernel/slicc_fs_calls; echo $n')).stdout);

async function looping(sh) {
  let last = await calls(sh);
  for (;;) {
    await new Promise((r) => setTimeout(r, 200));
    const now = await calls(sh);
    if (now - last > 500) return;
    last = now;
  }
}

const filling = (dir, lines) => [
  `f = '${dir}/f'`,
  `open('${dir}/ready', 'w').close()`,
  ...held(`${dir}/go`),
  ...lines,
  ...listed(`${dir}-sig/go2`),
];

async function filled(page, mine, dir) {
  await until(mine, `${dir}/ready`);
  await programClock(page, { freeze: true });
  assert.deepEqual(await mine(`: > ${dir}/go`), ok());
  await looping(mine);
}

const programClock = (page, change) =>
  page.evaluate(async (c) => {
    const control = new BroadcastChannel('notice-caches-program-clock');
    const id = Math.random();
    const done = new Promise((resolve) => {
      control.onmessage = ({ data }) => data.done === id && resolve();
    });
    control.postMessage({ ...c, id });
    await done;
    control.close();
  }, change);

const kernelOf = (page, name) => (script) =>
  page.evaluate((n, s) => window[n].run(['bash', '-c', s], { cwd: '/' }), name, script);

const started = (page, name, script) =>
  page.evaluate(
    (n, s) => {
      window.pcRun = window[n].run(['bash', '-c', s], { cwd: '/' });
      return true;
    },
    name,
    script
  );

const finished = (page) => page.evaluate(() => window.pcRun);

async function until(sh, path) {
  for (;;) {
    const r = await sh(`[ -e ${path} ] && echo yes || echo no`);
    if (r.stdout === 'yes\n') return;
  }
}

async function setup(t, dir, { mine = 'program-clock', theirs = 'deaf' } = {}) {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  assert.deepEqual(
    await bash(`rm -rf ${dir} ${dir}-sig && mkdir -p ${dir} ${dir}-sig && echo 1 > ${dir}/f`, {
      cwd: '/',
    }),
    ok()
  );
  await page.evaluate(
    async (m, o) => {
      await window.secondKernel({ worker: new URL(`/notice/${m}-worker.js`, location.href) }, 'a');
      await window.secondKernel(
        o ? { worker: new URL(`/notice/${o}-worker.js`, location.href) } : {},
        'b'
      );
    },
    mine,
    theirs
  );
  const a = kernelOf(page, 'a');
  assert.deepEqual(await a('cat /proc/sys/kernel/slicc_shared_root'), ok('1\n'));
  return { page, a, b: kernelOf(page, 'b') };
}

test("a program polling stat while another kernel's notice is lost asks the kernel again 2 ms after each answer, however often it looks, and so sees the change (#1017)", async (t) => {
  const dir = '/tmp/pp';
  const { page, a, b } = await setup(t, dir);
  const idle = -(await calls(a)) + (await calls(a));
  await started(
    page,
    'a',
    py([
      `f = '${dir}/f'`,
      `open('${dir}/ready', 'w').close()`,
      'n = 0',
      `while os.stat(f).st_size != 6 and n < ${CAP}: n += 1`,
      `print('seen' if n < ${CAP} else 'stale')`,
    ])
  );
  await until(b, `${dir}/ready`);
  const before = await calls(a);
  await new Promise((r) => setTimeout(r, 1000));
  const asked = (await calls(a)) - before - idle;
  assert.deepEqual(await b(`echo 12345 > ${dir}/f`), ok());
  assert.deepEqual(await finished(page), ok('seen\n'));
  assert.ok(asked > 100, `kernel calls in 1 s of polling: ${asked}`);
});

test("a directory another kernel renames moves away from a program's cached look inside it once the notice arrives, even while its own clock stands still (#1017)", async (t) => {
  const dir = '/tmp/pn';
  const { page, a, b } = await setup(t, dir, { theirs: null });
  assert.deepEqual(await a(`mkdir ${dir}/d && echo 1 > ${dir}/d/f`), ok());
  await started(
    page,
    'a',
    py([
      ...filling(dir, [`before = os.path.exists('${dir}/d/f')`]),
      `print(before, os.path.exists('${dir}/d/f'))`,
    ])
  );
  await filled(page, a, dir);
  assert.deepEqual(await b(`mv ${dir}/d ${dir}/e`), ok());
  assert.deepEqual(await a(`: > ${dir}-sig/go2`), ok());
  assert.deepEqual(await finished(page), ok('True False\n'));
});

test("a lock granted after another kernel's write gives a program the new size, even with the notice lost and its own clock standing still (#1017, #949)", async (t) => {
  const dir = '/tmp/pl';
  const { page, a, b } = await setup(t, dir);
  await started(
    page,
    'a',
    py([
      ...filling(dir, ['h = open(f)', 'before = os.stat(f).st_size']),
      'fcntl.flock(h, fcntl.LOCK_EX)',
      'print(before, os.stat(f).st_size, h.read().strip())',
    ])
  );
  await filled(page, a, dir);
  assert.deepEqual(
    await b(
      py([
        `h = open('${dir}/f', 'r+')`,
        'fcntl.flock(h, fcntl.LOCK_EX)',
        "h.write('12345\\n')",
        'h.close()',
      ])
    ),
    ok()
  );
  assert.deepEqual(await a(`: > ${dir}-sig/go2`), ok());
  assert.deepEqual(await finished(page), ok('2 6 12345\n'));
});

test('a kernel that another kernel joins drops what its programs cached alone, even with the notices lost and the clock standing still (#1017)', async (t) => {
  const dir = '/tmp/pj';
  const { page, bash } = await booted(chrome, t, { worker: '/notice/program-clock-worker.js' });
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  assert.deepEqual(
    await bash(`rm -rf ${dir} ${dir}-sig && mkdir -p ${dir} ${dir}-sig && echo 1 > ${dir}/f`, {
      cwd: '/',
    }),
    ok()
  );
  const mine = kernelOf(page, 'kernel');
  await started(
    page,
    'kernel',
    py([...filling(dir, ['before = os.stat(f).st_size']), 'print(before, os.stat(f).st_size)'])
  );
  await filled(page, mine, dir);
  await page.evaluate(() =>
    window.secondKernel({ worker: new URL('/notice/deaf-worker.js', location.href) }, 'b')
  );
  assert.deepEqual(await mine('cat /proc/sys/kernel/slicc_shared_root'), ok('1\n'));
  assert.deepEqual(await kernelOf(page, 'b')(`echo 12345 > ${dir}/f`), ok());
  assert.deepEqual(await mine(`: > ${dir}-sig/go2`), ok());
  assert.deepEqual(await finished(page), ok('2 6\n'));
});

test('a file another kernel saves by a temporary and a rename gives a program its new size and bytes once the notice arrives, and a stat-sized read is never short (#1017, #954, #1026)', async (t) => {
  const dir = '/tmp/ps';
  const { page, a, b } = await setup(t, dir, { theirs: null });
  await started(
    page,
    'a',
    py([
      ...filling(dir, ['before = os.stat(f).st_size', `os.path.exists('${dir}/m')`]),
      'n = 0',
      `while not os.path.exists('${dir}/m') and n < ${CAP}: n += 1`,
      'size = os.stat(f).st_size',
      'fd = os.open(f, os.O_RDONLY)',
      'data = os.pread(fd, size, 0)',
      'print(before, size, len(data), data.decode().strip())',
    ])
  );
  await filled(page, a, dir);
  assert.deepEqual(
    await b(`echo saved-longer > ${dir}/.f.tmp && mv ${dir}/.f.tmp ${dir}/f && : > ${dir}/m`),
    ok()
  );
  assert.deepEqual(await a(`: > ${dir}-sig/go2`), ok());
  assert.deepEqual(await finished(page), ok('2 13 13 saved-longer\n'));
});

test('with an idle peer on the root, pnpm installing a package of many files asks the kernel at most 1.5 times as often per file as alone (#1017)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  for (const name of ['wasm-coreutils', 'wasm-tar', 'wasm-tls-engine', 'wasi-pnpm']) {
    await installPackage(page, name);
  }
  const dir = await mkdtemp(join(tmpdir(), 'slicc-gate-'));
  await mkdir(join(dir, 'package'));
  await writeFile(join(dir, 'package', 'package.json'), '{"name":"many","version":"1.0.0"}');
  for (let d = 1; d <= GATE_DIRS; d++) {
    await mkdir(join(dir, 'package', `d${d}`));
    for (let f = 1; f <= 40; f++) {
      await writeFile(
        join(dir, 'package', `d${d}`, `f${f}.js`),
        `export const v = ${d * 100 + f};\n`
      );
    }
  }
  execFileSync('tar', ['czf', join(dir, 'many.tgz'), '-C', dir, 'package'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const bytes = (await readFile(join(dir, 'many.tgz'))).toString('base64');
  await rm(dir, { recursive: true, force: true });
  await page.evaluate(
    (b) =>
      window.opfs.write(
        'srv/many.tgz',
        Uint8Array.from(atob(b), (c) => c.charCodeAt(0))
      ),
    bytes
  );
  const sh = kernelOf(page, 'kernel');
  const add = async (n) => {
    const before = await calls(sh);
    const r = await bash(
      `rm -rf /home/g${n} /home/gs${n} && mkdir -p /home/g${n} && cd /home/g${n} && echo '{}' > package.json && pnpm add file:/srv/many.tgz --store-dir /home/gs${n} >/dev/null 2>&1; echo "rc=$?"; ls -d node_modules/many/d*/f*.js | wc -l`,
      { cwd: '/' }
    );
    assert.deepEqual(r, ok(`rc=0\n${GATE_DIRS * 40}\n`));
    return (await calls(sh)) - before;
  };
  const alone = await add(1);
  await page.evaluate(() => window.secondKernel({}));
  assert.deepEqual(await sh('cat /proc/sys/kernel/slicc_shared_root'), ok('1\n'));
  const peered = await add(2);
  console.log(`kernel calls for ${GATE_DIRS * 40} files: alone ${alone}, with a peer ${peered}`);
  assert.ok(alone > 0, 'the kernel counts its calls');
  assert.ok(peered <= GATE_RATIO * alone, `alone ${alone}, with a peer ${peered}`);
});
