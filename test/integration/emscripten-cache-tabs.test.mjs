import assert from 'node:assert/strict';
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

const started = (page, name, script) =>
  page.evaluate(
    (n, s) => {
      window.ecRun = window[n].run(['bash', '-c', s], { cwd: '/' });
      return true;
    },
    name,
    script
  );

const finished = (page) => page.evaluate(() => window.ecRun);

const calls = async (sh) =>
  Number((await sh('read -r n < /proc/sys/kernel/slicc_fs_calls; echo $n')).stdout);

async function looping(sh, idle) {
  let last = await calls(sh);
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const now = await calls(sh);
    if (now - last - idle > 5) return;
    last = now;
  }
}

async function setup(t, dir, theirs) {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash(`rm -rf ${dir} && mkdir -p ${dir} && : > ${dir}/x && echo new > ${dir}/new`, {
      cwd: '/',
    }),
    ok()
  );
  await page.evaluate(async (o) => {
    await window.secondKernel(
      { worker: new URL('/notice/program-clock-worker.js', location.href) },
      'a'
    );
    await window.secondKernel(
      o ? { worker: new URL(`/notice/${o}-worker.js`, location.href) } : {},
      'b'
    );
  }, theirs);
  const a = kernelOf(page, 'a');
  assert.deepEqual(await a('cat /proc/sys/kernel/slicc_shared_root'), ok('1\n'));
  return { page, a, b: kernelOf(page, 'b') };
}

const waiting = (dir, before, afterwards) =>
  `${before}; r1=$?; until [ -e ${dir}/go ]; do :; done; ${afterwards}; echo "$r1 $?"`;

for (const [what, theirs, advance] of [
  ['its notice is lost and 100 ms of its clock pass', 'deaf', 101],
  ['its notice arrives', null, 0],
]) {
  test(`a bash program's cached stat of a name another kernel renames a new file over shows the new file once ${what} (#1017)`, async (t) => {
    const dir = `/tmp/er${advance}`;
    const { page, a, b } = await setup(t, dir, theirs);
    await programClock(page, { freeze: true });
    const idle = -(await calls(a)) + (await calls(a));
    await started(page, 'a', waiting(dir, `[ -s ${dir}/x ]`, `[ -s ${dir}/x ]`));
    await looping(a, idle);
    assert.deepEqual(await b(`mv ${dir}/new ${dir}/x`), ok());
    if (advance) await programClock(page, { advance });
    assert.deepEqual(await a(`: > ${dir}/go`), ok());
    assert.deepEqual(await finished(page), ok('1 0\n'));
  });
}

test("a bash program looping on a name another kernel creates sees it, even with the notice lost and the program's clock standing still (#1017)", async (t) => {
  const dir = '/tmp/ee';
  const { page, a, b } = await setup(t, dir, 'deaf');
  await programClock(page, { freeze: true });
  const idle = -(await calls(a)) + (await calls(a));
  await started(
    page,
    'a',
    `n=0; while [ ! -e ${dir}/made ] && (( n < 200000 )); do n=$((n + 1)); done; (( n < 200000 )) && echo seen || echo stale`
  );
  await looping(a, idle);
  assert.deepEqual(await b(`: > ${dir}/made`), ok());
  assert.deepEqual(await finished(page), ok('seen\n'));
});

test('with an idle peer on the root, tar unpacking an archive of symlinks asks the kernel at most 1.1 times as often as alone (#1017)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  for (const name of ['wasm-coreutils', 'wasm-tar']) await installPackage(page, name);
  assert.deepEqual(
    await bash(
      'rm -rf /tmp/et && mkdir -p /tmp/et/src/inner && cd /tmp/et/src/inner && echo first > ../a.txt && for i in $(seq 60); do ln -s ../a.txt l$i; done && cd /tmp/et && tar -cf src.tar src',
      { cwd: '/' }
    ),
    ok()
  );
  const sh = kernelOf(page, 'kernel');
  const unpack = async () => {
    const before = await calls(sh);
    assert.deepEqual(
      await bash(
        'cd /tmp/et; s=$(wc -c < src.tar); for i in 1 2 3; do rm -rf out && mkdir out; { head -c $((s - 10240)) src.tar; sleep 0.2; tail -c 10240 src.tar; } | tar -xf - -C out || echo fail; done; [ "$(cat out/src/inner/l60)" = first ] && echo good',
        { cwd: '/' }
      ),
      ok('good\n')
    );
    return (await calls(sh)) - before;
  };
  const alone = await unpack();
  await page.evaluate(() => window.secondKernel({}));
  assert.deepEqual(await sh('cat /proc/sys/kernel/slicc_shared_root'), ok('1\n'));
  const peered = await unpack();
  console.log(`kernel calls for 3 tar unpacks: alone ${alone}, with a peer ${peered}`);
  assert.ok(alone > 0, 'the kernel counts its calls');
  assert.ok(peered <= 1.1 * alone, `alone ${alone}, with a peer ${peered}`);
});
