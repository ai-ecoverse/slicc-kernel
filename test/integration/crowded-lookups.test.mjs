import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const DEEP = '/tmp/cl/a/b/c/d/e/f/g/h';
const LOOKUPS = 2000;
const RATIO = 3;

const shared = (page) =>
  page.evaluate(async () => {
    const r = await window.kernel.run(['cat', '/proc/sys/kernel/slicc_shared_root'], { cwd: '/' });
    return r.stdout.trim();
  });

test('a tab that closes stops counting as a peer at once, without waiting for a write to prune it (#984)', async (t) => {
  const { page } = await booted(chrome, t);
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await other.evaluate(() => window.boot({}));
  assert.equal(await shared(page), '1');
  await other.close();
  const seen = [];
  for (let i = 0; i < 30 && seen.at(-1) !== '0'; i++) {
    seen.push(await shared(page));
    if (seen.at(-1) !== '0') await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(seen.at(-1), '0', `after the peer's tab closed: ${seen.join(' ')}`);
});

test('with an idle peer on the root, a program looking up names deep in a tree asks the kernel at most a few times as often as alone (#984)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash(`rm -rf /tmp/cl && mkdir -p ${DEEP} && : > ${DEEP}/x`, { cwd: '/' }),
    ok()
  );
  const lookups = `n=0; for i in $(seq ${LOOKUPS}); do [ -e ${DEEP}/x ] && n=$((n + 1)); [ -e ${DEEP}/y$i ] || n=$((n + 1)); done; echo "n=$n"`;
  const calls = async () =>
    Number((await bash('cat /proc/sys/kernel/slicc_fs_calls', { cwd: '/' })).stdout);
  const counted = async () => {
    const before = await calls();
    const t0 = Date.now();
    assert.deepEqual(await bash(lookups, { cwd: '/' }), ok(`n=${2 * LOOKUPS}\n`));
    const ms = Date.now() - t0;
    return { calls: (await calls()) - before, ms };
  };
  const alone = await counted();
  await page.evaluate(() => window.secondKernel({}));
  assert.equal(await shared(page), '1');
  const peered = await counted();
  console.log(
    `kernel calls for ${2 * LOOKUPS} lookups: alone ${alone.calls} in ${alone.ms} ms, with a peer ${peered.calls} in ${peered.ms} ms`
  );
  assert.ok(
    peered.calls <= RATIO * alone.calls,
    `alone ${alone.calls} calls, with a peer ${peered.calls}`
  );
});

test('a directory another kernel renames while a program keeps it cached shows the new layout at the program’s next lookup (#984, #959)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash('rm -rf /tmp/cr && mkdir -p /tmp/cr/d && echo old > /tmp/cr/d/f', { cwd: '/' }),
    ok()
  );
  const r = await page.evaluate(async () => {
    await window.secondKernel({});
    const reader = window.kernel.run(
      [
        'bash',
        '-c',
        'read -r a < /tmp/cr/d/f; [ -d /tmp/cr/d ] && : > /tmp/cr/ready; while [ ! -e /tmp/cr/go ]; do sleep 0.05; done; read -r b < /tmp/cr/d/f; read -r c < /tmp/cr/e/f; echo "$a $b $c"',
      ],
      { cwd: '/' }
    );
    const writer = window.second.run(
      [
        'bash',
        '-c',
        'while [ ! -e /tmp/cr/ready ]; do sleep 0.05; done; mv /tmp/cr/d /tmp/cr/e && mkdir /tmp/cr/d && echo new > /tmp/cr/d/f && : > /tmp/cr/go',
      ],
      { cwd: '/' }
    );
    return Promise.all([reader, writer]);
  });
  assert.deepEqual(r[1], ok());
  assert.deepEqual(r[0], ok('old new old\n'));
});

const replaced = (dir, wait) =>
  `rm -rf ${dir} && mkdir -p ${dir}/t && echo new > ${dir}/t/x && echo plain > ${dir}/n && cd ${dir} && : > ready && [ -f n ] && ${wait} && cd n && read -r v < x && echo "$v"`;
const replace = (dir) =>
  `while [ ! -e ${dir}/ready ]; do sleep 0.05; done; sleep 0.3; cd ${dir} && rm n && ln -s t n && echo x > done`;

for (const [n, what, wait] of [
  [
    1,
    'only reads the clock',
    'end=$(( ${EPOCHREALTIME/./} + 1500000 )); while (( ${EPOCHREALTIME/./} < end )); do :; done',
  ],
  [2, 'sleeps', 'sleep 1.5'],
  [
    3,
    'reads the file the other kernel wrote last',
    'until read -r _ 2>/dev/null < done; do :; done',
  ],
]) {
  test(`a name another kernel replaces by a symlink resolves through the link once the program ${what} (#984, #959)`, async (t) => {
    const { page } = await booted(chrome, t);
    const [reader, writer] = await page.evaluate(
      async (r, w) => {
        await window.secondKernel({});
        return Promise.all([
          window.kernel.run(['bash', '-c', r], { cwd: '/' }),
          window.second.run(['bash', '-c', w], { cwd: '/' }),
        ]);
      },
      replaced(`/tmp/cs${n}`, wait),
      replace(`/tmp/cs${n}`)
    );
    assert.deepEqual(writer, ok());
    assert.deepEqual(reader, ok('new\n'));
  });
}

test('a program that only reads the clock after looking a name up sees the symlink another kernel put there in the meantime (#984, #959)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await page.evaluate(async () => {
    for (const name of ['package.json', 'bin/clocklink', 'bin/clocklink.wasm']) {
      const bytes = await (await fetch(`/fixtures/clocklink/${name}`)).arrayBuffer();
      await window.opfs.write(`node_modules/clocklink/${name}`, bytes);
    }
  });
  assert.deepEqual(
    await bash('rm -rf /tmp/ck && mkdir -p /tmp/ck && echo plain > /tmp/ck/n', { cwd: '/' }),
    ok()
  );
  const [reader, writer] = await page.evaluate(async () => {
    await window.secondKernel({});
    return Promise.all([
      window.kernel.run(['clocklink', 'n', 'ready', '1500'], { cwd: '/tmp/ck' }),
      window.second.run(
        [
          'bash',
          '-c',
          'while [ ! -e /tmp/ck/ready ]; do sleep 0.05; done; sleep 0.3; cd /tmp/ck && rm n && ln -s t n',
        ],
        { cwd: '/' }
      ),
    ]);
  });
  assert.deepEqual(writer, ok());
  assert.deepEqual(reader, ok('first=EINVAL second=t\n'));
});
