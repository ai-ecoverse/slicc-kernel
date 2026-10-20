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

const calls = async (sh) =>
  Number((await sh('read -r n < /proc/sys/kernel/slicc_fs_calls; echo $n')).stdout);

for (const [ms, shows] of [
  [50, 'wrote'],
  [101, 'EROFS'],
]) {
  test(`with another kernel on the root, a physical /proc that appears is taken into account ${ms} ms of the program's clock later: never more than 100 ms (#1017)`, async (t) => {
    const { page, bash } = await booted(chrome, t);
    await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
    assert.deepEqual(
      await bash('rm -rf /tmp/pq && mkdir -p /tmp/pq && ln -s /proc/version /tmp/pq/l', {
        cwd: '/',
      }),
      ok()
    );
    await page.evaluate(async () => {
      await window.secondKernel(
        { worker: new URL('/notice/program-clock-worker.js', location.href) },
        'a'
      );
      await window.secondKernel({ worker: new URL('/notice/deaf-worker.js', location.href) }, 'b');
    });
    const a = kernelOf(page, 'a');
    assert.deepEqual(await a('cat /proc/sys/kernel/slicc_shared_root'), ok('1\n'));
    await page.evaluate(() => {
      window.pqRun = window.a.run(
        [
          'bash',
          '-c',
          `python3 -c "$(echo ${btoa(
            [
              'import os',
              "open('/tmp/pq/ready', 'w').close()",
              "while 'go0' not in os.listdir('/tmp/pq-sig'): pass",
              "open('/tmp/pq/filled', 'w').close()",
              "while 'go' not in os.listdir('/tmp/pq-sig'): pass",
              'try:',
              "    open('/tmp/pq/l', 'a').close()",
              "    print('wrote')",
              'except OSError as e:',
              "    print('EROFS' if 'Read-only' in str(e) else e)",
            ].join('\n')
          )} | base64 -d)"`,
        ],
        { cwd: '/' }
      );
    });
    assert.deepEqual(await bash('mkdir -p /tmp/pq-sig', { cwd: '/' }), ok());
    const until = async (path) => {
      for (;;) {
        const r = await a(`[ -e ${path} ] && echo yes || echo no`);
        if (r.stdout === 'yes\n') return;
      }
    };
    await until('/tmp/pq/ready');
    await programClock(page, { freeze: true });
    await programClock(page, { advance: 101 });
    assert.deepEqual(await a(': > /tmp/pq-sig/go0'), ok());
    await until('/tmp/pq/filled');
    await page.evaluate(async () => {
      const top = await navigator.storage.getDirectory();
      const proc = await top.getDirectoryHandle('proc', { create: true });
      const w = await (await proc.getFileHandle('version', { create: true })).createWritable();
      await w.write('PHYSICAL\n');
      await w.close();
    });
    await programClock(page, { advance: ms });
    assert.deepEqual(await a(': > /tmp/pq-sig/go'), ok());
    assert.deepEqual(await page.evaluate(() => window.pqRun), ok(`${shows}\n`));
    await page.evaluate(async () =>
      (await navigator.storage.getDirectory()).removeEntry('proc', { recursive: true })
    );
  });
}

test('with an idle peer on the root, pnpm installing a package of many files asks the kernel at most 1.15 times as often per file as alone (#1017)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  for (const name of ['wasm-coreutils', 'wasm-tar', 'wasm-tls-engine', 'wasi-pnpm']) {
    await installPackage(page, name);
  }
  const dir = await mkdtemp(join(tmpdir(), 'slicc-procgate-'));
  await mkdir(join(dir, 'package'));
  await writeFile(join(dir, 'package', 'package.json'), '{"name":"many","version":"1.0.0"}');
  for (let d = 1; d <= 6; d++) {
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
    assert.deepEqual(r, ok('rc=0\n240\n'));
    return (await calls(sh)) - before;
  };
  const alone = await add(1);
  await page.evaluate(() => window.secondKernel({}));
  assert.deepEqual(await sh('cat /proc/sys/kernel/slicc_shared_root'), ok('1\n'));
  const peered = await add(2);
  console.log(`kernel calls for 240 files: alone ${alone}, with a peer ${peered}`);
  assert.ok(alone > 0, 'the kernel counts its calls');
  assert.ok(peered <= 1.15 * alone, `alone ${alone}, with a peer ${peered}`);
});
