import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const WRITER = (file, moved) =>
  [
    'import os',
    `fd = os.open('${file}', os.O_WRONLY | os.O_CREAT | os.O_APPEND)`,
    'n = 0',
    'end = None',
    'try:',
    '    while n < 20000:',
    "        os.write(fd, f'{n}\\n'.encode())",
    '        n += 1',
    `        if end is None and os.path.exists('${moved}'): end = n + 200`,
    '        if end is not None and n >= end: break',
    "    print(n, 'ok')",
    'except OSError as e:',
    "    print(n, 'errno', e.errno)",
  ].join('\n');

async function written(page, writer, { dir, file, from, to, renamed }) {
  await sh(page, `rm -rf ${dir} && mkdir -p ${dir}/a && echo made`);
  await writer.evaluate(
    (s) => {
      window.writeRun = window.kernel.run(['python3', '-c', s], { cwd: '/' });
    },
    WRITER(file, `${dir}/moved`)
  );
  for (;;) {
    const r = await sh(page, `[ -s ${file} ] && echo yes || echo no`);
    if (r.stdout === 'yes\n') break;
  }
  assert.deepEqual(
    await sh(page, `mv ${from} ${to} && : > ${dir}/moved && echo moved`),
    ok('moved\n')
  );
  const wrote = await writer.evaluate(() => window.writeRun);
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.match(wrote.stdout, /^\d+ ok\n$/, `every write succeeded: ${wrote.stdout}`);
  const n = Number(wrote.stdout.split(' ')[0]);
  const r = await sh(
    page,
    `wc -l < ${renamed}; sort -n -u ${renamed} | wc -l; tail -1 ${renamed}; [ -e ${file} ] && echo old || echo gone`
  );
  assert.deepEqual(r, ok(`${n}\n${n}\n${n - 1}\ngone\n`), `every byte is at ${renamed}`);
}

test("a program's open file follows a rename of its directory by another process in the same kernel (#1257)", {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  for (let round = 0; round < 6; round++) {
    const dir = `/root/fd1-${round}`;
    await written(page, page, {
      dir,
      file: `${dir}/a/log`,
      from: `${dir}/a`,
      to: `${dir}/b`,
      renamed: `${dir}/b/log`,
    });
  }
});

test("a program's open file follows a rename of the file itself by another process (#1257)", {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  for (let round = 0; round < 6; round++) {
    const dir = `/root/fd2-${round}`;
    await written(page, page, {
      dir,
      file: `${dir}/a/f`,
      from: `${dir}/a/f`,
      to: `${dir}/a/g`,
      renamed: `${dir}/a/g`,
    });
  }
});

test("an Emscripten program's open file follows a rename of its directory by another process (#1257)", {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  const dir = '/root/fd3';
  assert.deepEqual(await sh(page, `mkdir -p ${dir}/a && echo made`), ok('made\n'));
  await page.evaluate((d) => {
    window.teeRun = window.kernel.run(
      [
        'bash',
        '-c',
        `n=0; while [ $n -lt 400 ]; do echo $n; n=$((n+1)); [ $n -eq 50 ] && until [ -e ${d}/moved ]; do :; done; done | tee -a ${d}/a/log > /dev/null; echo tee $?`,
      ],
      { cwd: '/' }
    );
  }, dir);
  for (;;) {
    const r = await sh(page, `[ -s ${dir}/a/log ] && echo yes || echo no`);
    if (r.stdout === 'yes\n') break;
  }
  assert.deepEqual(
    await sh(page, `mv ${dir}/a ${dir}/b && : > ${dir}/moved && echo moved`),
    ok('moved\n')
  );
  const teed = await page.evaluate(() => window.teeRun);
  assert.deepEqual(teed, ok('tee 0\n'));
  assert.deepEqual(
    await sh(
      page,
      `wc -l < ${dir}/b/log; tail -1 ${dir}/b/log; [ -e ${dir}/a ] && echo old || echo gone`
    ),
    ok('400\n399\ngone\n')
  );
});

test("a program's open file in one tab follows a rename of its directory in another tab (#1257, #1140)", {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  for (let i = 0; i < 120; i++)
    await sh(page, `mkdir -p /root/fd4/a/lib && echo ${i} > /root/fd4/a/lib/f${i}`);
  await written(page, other, {
    dir: '/root/fd4',
    file: '/root/fd4/a/log',
    from: '/root/fd4/a',
    to: '/root/fd4/b',
    renamed: '/root/fd4/b/log',
  });
});

test('renames by one program while it holds files open cost it no extra kernel calls, and /t/ab is not moved by /t/a (#1257)', {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const script = [
    'import os',
    "os.makedirs('/root/fd5/t/a', exist_ok=True)",
    "os.makedirs('/root/fd5/t/ab', exist_ok=True)",
    "held = open('/root/fd5/t/ab/held', 'a')",
    "calls = lambda: int(open('/proc/sys/kernel/slicc_fs_calls').read())",
    'before = calls()',
    'for i in range(200):',
    "    open(f'/root/fd5/t/a/x{i}', 'w').close()",
    "    os.rename(f'/root/fd5/t/a/x{i}', f'/root/fd5/t/a/y{i}')",
    "    held.write(f'{i}\\n'); held.flush()",
    'used = calls() - before',
    'held.close()',
    'print(used)',
  ].join('\n');
  const r = await page.evaluate(
    (s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }),
    script
  );
  assert.equal(r.status, 0, r.stderr);
  const used = Number(r.stdout);
  console.log(`kernel calls for 200 creates, renames and appends: ${used}`);
  assert.deepEqual(
    await sh(page, 'wc -l < /root/fd5/t/ab/held; ls /root/fd5/t/a | wc -l'),
    ok('200\n200\n')
  );
  assert.ok(used < 200 * 7.5, `${used} kernel calls, where main makes 1405`);
});

test("a watch in one tab follows a rename of a directory above it in another tab, so this tab's later changes there arrive (#1356, #1257)", {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  for (const file of ['package.json', 'bin/watchtest.mjs']) {
    const text = await readFile(new URL(`./fixtures/watchtest/${file}`, import.meta.url), 'utf8');
    await page.evaluate((p, s) => window.opfs.write(p, s), `node_modules/watchtest/${file}`, text);
  }
  const other = await peerTab(page);
  assert.deepEqual(
    await sh(page, 'rm -rf /root/fw && mkdir -p /root/fw/a/w && echo made'),
    ok('made\n')
  );
  await page.evaluate(() => {
    window.watchRun = window.kernel.run(
      ['watchtest', 'events', '/root/fw/a/w', 'end', '/root/fw/ready'],
      { cwd: '/' }
    );
  });
  for (;;) {
    const r = await sh(page, '[ -e /root/fw/ready ] && echo yes || echo no');
    if (r.stdout === 'yes\n') break;
  }
  assert.deepEqual(await sh(other, 'mv /root/fw/a /root/fw/b && echo moved'), ok('moved\n'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(await sh(page, ': > /root/fw/b/w/end && echo touched'), ok('touched\n'));
  const watched = await page.evaluate(() =>
    Promise.race([
      window.watchRun,
      new Promise((resolve) => setTimeout(() => resolve({ stdout: 'no event in 20 s\n' }), 20_000)),
    ])
  );
  assert.equal(watched.stdout, 'rename end\n');
});
