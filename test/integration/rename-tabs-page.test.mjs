import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import {
  acks,
  kernelIn,
  PEER_WORKER,
  peerTab,
  sh,
  steer,
  tree,
  untilFound,
  whole,
  wholeAs,
} from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const FILES = 120;
const BIG = 400;
const ROUNDS = Number(process.env.RENAME_ROUNDS ?? 20);
const KILLS = Number(process.env.RENAME_KILLS ?? 8);

const POLL = (dir, pause = '') =>
  [
    `cd ${dir}`,
    'shopt -s nullglob',
    'n=0; bad=0',
    'names() { local x out=""; for x in *; do case $x in a|b) out="$out$x";; esac; done; echo "$out"; }',
    'while [ ! -e stop ]; do',
    '  before=$(names)',
    '  if [ "$before" != a ] && [ "$before" != b ]; then',
    '    bad=$((bad+1)); [ $bad -le 5 ] && echo "parent shows [$before]"',
    '  else',
    ...(pause ? [`    ${pause}`] : []),
    '    files=($before/lib/*); c=${#files[@]}',
    '    if [ -e $before/package.json ]; then p=1; else p=0; fi',
    ...(pause ? [`    ${pause}`] : []),
    '    after=$(names)',
    `    if [ "$after" = "$before" ] && { [ $c -ne ${FILES} ] || [ $p -eq 0 ]; }; then`,
    '      bad=$((bad+1)); [ $bad -le 5 ] && echo "partial $before: $c package.json=$p"',
    '    fi',
    '  fi',
    '  n=$((n+1)); echo $n > tick',
    'done',
    'echo "samples $n bad $bad"',
  ].join('\n');

const SETTLE_S = 30;

const SETTLE = [
  'settle() {',
  '  local t u end=$((SECONDS + ' + SETTLE_S + '))',
  '  read -r t 2>/dev/null < tick',
  '  until read -r u 2>/dev/null < tick; [ "$u" != "$t" ]; do',
  '    if [ $SECONDS -ge $end ]; then echo "the poller took no sample in ' +
    SETTLE_S +
    ' s, last at ${t:-none}"; return 1; fi',
  '  done',
  '}',
].join('\n');

const ROUND = (dir, paced) =>
  `cd ${dir} && ${SETTLE}\nmv a b && ${paced ? 'settle && ' : ''}mv b a && ${paced ? 'settle && ' : ''}echo renamed`;

async function renames(page, dir, paced) {
  try {
    for (let r = 1; r <= ROUNDS; r++) {
      const round = await sh(page, ROUND(dir, paced));
      if (round.stdout !== 'renamed\n') return { ...round, round: r };
    }
    return ok('renamed\n');
  } finally {
    await sh(page, `: > ${dir}/stop`);
  }
}

async function polled(page, other, { at, through = at, label, pause = '', paced = true }) {
  await sh(page, `rm -f ${at}/stop ${at}/tick`);
  await other.evaluate(
    (s) => {
      window.pollRun = window.kernel.run(['bash', '-c', s], { cwd: '/' });
    },
    POLL(at, pause)
  );
  const renamed = await renames(page, through, paced);
  const poll = await other.evaluate(() => window.pollRun);
  console.log(`${label}: ${poll.stdout.trim().split('\n').at(-1)}`);
  assert.deepEqual(renamed, ok('renamed\n'));
  assert.match(poll.stdout, /samples [1-9]\d* bad 0\n$/, poll.stdout.slice(0, 2000));
}

test('another tab polling a directory a kernel renames back and forth never sees it half moved, nor both names in the parent (#1140)', {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  const dir = '/root/rt';
  assert.deepEqual(await sh(page, tree(dir, FILES)), ok('made\n'));
  const other = await peerTab(page);
  await polled(page, other, { at: dir, label: 'poller' });
  await polled(page, other, {
    at: dir,
    label: `a poller slower than the renames${process.env.RENAME_UNPACED ? ' (unpaced)' : ''}`,
    pause: `sleep ${process.env.RENAME_PAUSE ?? '0.15'}`,
    paced: process.env.RENAME_UNPACED === undefined,
  });
  const seen = await sh(other, whole(dir));
  assert.ok(wholeAs(FILES)(seen.stdout), seen.stdout);
  assert.deepEqual(
    await sh(page, `mkdir -p /root/rs/real && ln -s real /root/rs/link && echo linked`),
    ok('linked\n')
  );
  assert.deepEqual(await sh(page, tree('/root/rs/real', FILES)), ok('made\n'));
  await polled(page, other, {
    at: '/root/rs/real',
    through: '/root/rs/link',
    label: 'through a link',
  });
});

const WRITER = (dir) =>
  [
    'import os',
    `fd = os.open('${dir}/a/log', os.O_WRONLY | os.O_CREAT | os.O_APPEND)`,
    'n = 0',
    "pad = 'x' * 65536",
    'end = None',
    'try:',
    '    while n < 4000:',
    "        os.write(fd, f'{n} {pad}\\n'.encode())",
    '        n += 1',
    `        if end is None and os.path.exists('${dir}/moved'): end = n + 200`,
    '        if end is not None and n >= end: break',
    "    print(n, 'ok')",
    'except OSError as e:',
    "    print(n, 'errno', e.errno)",
  ].join('\n');

async function written(page, other, dir) {
  await sh(page, `rm -f ${dir}/moved`);
  assert.deepEqual(await sh(page, tree(dir, FILES)), ok('made\n'));
  await other.evaluate((s) => {
    window.writeRun = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, WRITER(dir));
  for (;;) {
    const r = await sh(page, `[ -s ${dir}/a/log ] && echo yes || echo no`);
    if (r.stdout === 'yes\n') break;
  }
  const began = performance.now();
  const moved = await sh(page, `mv ${dir}/a ${dir}/b 2>&1; echo "mv $?"; : > ${dir}/moved`);
  const took = performance.now() - began;
  const wrote = await other.evaluate(() => window.writeRun);
  assert.equal(wrote.status, 0, wrote.stderr);
  const [n, outcome, errno] = wrote.stdout.trim().split(' ');
  const where = moved.stdout.startsWith('mv 0') ? 'b' : 'a';
  const r = await sh(
    page,
    `cd ${dir} && wc -l < ${where}/log; cut -d' ' -f1 ${where}/log | sort -n -u | wc -l; tail -1 ${where}/log | cut -d' ' -f1; [ -e ${where === 'b' ? 'a' : 'b'} ] && echo both || echo one`
  );
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(
    lines,
    [n, n, String(Number(n) - 1), 'one'],
    `every write that returned success is at ${where}/log: ${JSON.stringify({ moved, wrote })}`
  );
  assert.ok(outcome === 'ok' || (outcome === 'errno' && errno === '44'), wrote.stdout);
  const seen = await sh(other, whole(dir));
  assert.ok(wholeAs(FILES)(seen.stdout), seen.stdout);
  return { moved: moved.stdout, took, outcome };
}

test("a peer tab's writes through an open descriptor are never lost silently while its directory is renamed, also when the peer is slow or stuck (#1140)", {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page, { worker: PEER_WORKER });
  const plain = await written(page, other, '/root/rw1');
  assert.match(plain.moved, /^mv 0/);
  await steer(other, { noticeDelay: 1500 });
  const slow = await written(page, other, '/root/rw2');
  assert.match(slow.moved, /^mv 0/);
  const waited = await acks(page);
  assert.ok(waited.most >= 1400, JSON.stringify(waited));
  assert.equal(waited.busy, 0);
  await steer(other, { noticeDelay: 600_000 });
  const stuck = await written(page, other, '/root/rw3');
  assert.match(stuck.moved, /Resource busy[\s\S]*mv 1/, stuck.moved);
  assert.ok(stuck.took >= 9000, `${stuck.took} ms`);
  assert.equal((await acks(page)).busy, 1);
  console.log(`acks: ${JSON.stringify(await acks(page))}`);
});

test('a kernel killed in the middle of a directory rename leaves every file exactly once, for the surviving tab, a tab that boots meanwhile and after a reboot (#1140)', {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t, { users: 'enforce' });
  await installPackage(page, 'wasm-coreutils');
  const dir = '/root/rk';
  const other = await peerTab(page, { name: 'k' });
  const third = await page.tab();
  await third.goto('/');
  await third.until(() => typeof window.boot === 'function');
  const marked = `chmod 640 ${dir}/a/lib/f1 && stat -c '%a %u' ${dir}/a/lib/f1 && stat -c %i ${dir}/a`;
  assert.deepEqual(await sh(page, tree(dir, BIG)), ok('made\n'));
  const began = performance.now();
  assert.equal((await sh(other, `mv ${dir}/a ${dir}/b && echo moved`, 'k')).stdout, 'moved\n');
  const full = performance.now() - began;
  console.log(`a whole rename of ${BIG} files takes ${Math.round(full)} ms`);
  for (let round = 0; round < KILLS; round++) {
    assert.deepEqual(await sh(page, tree(dir, BIG)), ok('made\n'));
    const before = (await sh(page, marked)).stdout;
    await other.evaluate((d) => {
      window.mv = window.k.run(['mv', `${d}/a`, `${d}/b`], { cwd: '/' }).catch(() => null);
    }, dir);
    await sleep(Math.round(((round + 0.5) / KILLS) * full));
    await other.evaluate(() => window.k.terminate());
    const booting = kernelIn(third, { name: `k${round}` });
    const survivor = await sh(page, whole(dir));
    assert.ok(wholeAs(BIG)(survivor.stdout), `survivor, round ${round}: ${survivor.stdout}`);
    await booting;
    const meanwhile = await sh(third, whole(dir), `k${round}`);
    assert.ok(wholeAs(BIG)(meanwhile.stdout), `third tab, round ${round}: ${meanwhile.stdout}`);
    await third.evaluate((n) => window[n].terminate(), `k${round}`);
    await kernelIn(other, { name: 'k' });
    const rebooted = await sh(other, whole(dir), 'k');
    assert.ok(wholeAs(BIG)(rebooted.stdout), `after a reboot, round ${round}: ${rebooted.stdout}`);
    const name = rebooted.stdout.trim()[0];
    assert.deepEqual(
      await sh(other, `stat -c '%a %u' ${dir}/${name}/lib/f1 && stat -c %i ${dir}/${name}`, 'k'),
      ok(before),
      `round ${round}`
    );
  }
});

test('a peer that misses the rename notice still never sees the tree half moved, since it checks the held rename locks at most every 100 ms (#1140)', {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  const other = await peerTab(page, { worker: `${PEER_WORKER}?old=1` });
  const dir = '/root/rl';
  for (let round = 0; round < 4; round++) {
    assert.deepEqual(await sh(page, tree(dir, BIG)), ok('made\n'));
    await page.evaluate((d) => {
      window.mv = window.kernel.run(['mv', `${d}/a`, `${d}/b`], { cwd: '/' });
    }, dir);
    await untilFound(page, `${dir.slice(1)}/b/lib`);
    await sleep(150);
    const deaf = await sh(other, whole(dir));
    assert.ok(wholeAs(BIG)(deaf.stdout), `deaf peer, round ${round}: ${deaf.stdout}`);
    assert.equal((await page.evaluate(() => window.mv)).status, 0);
  }
});

test('a tab that joins the root in the middle of a directory rename never sees the tree half moved (#1140)', {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  const dir = '/root/rj';
  for (let round = 0; round < 3; round++) {
    assert.deepEqual(await sh(page, tree(dir, BIG)), ok('made\n'));
    await page.evaluate((d) => {
      window.mv = window.kernel.run(['mv', `${d}/a`, `${d}/b`], { cwd: '/' });
    }, dir);
    await untilFound(page, `${dir.slice(1)}/b/lib`);
    const late = await page.tab();
    await late.goto('/');
    await late.until(() => typeof window.boot === 'function');
    await kernelIn(late);
    const joiner = await sh(late, whole(dir));
    assert.ok(wholeAs(BIG)(joiner.stdout), `joiner, round ${round}: ${joiner.stdout}`);
    assert.equal((await page.evaluate(() => window.mv)).status, 0);
    await late.evaluate(() => window.kernel.terminate());
    await late.close();
  }
});

const COUNT = (dir) =>
  `shopt -s globstar nullglob; f=(${dir}/**/lib/f*); echo \${#f[@]}; cat "\${f[@]}" | sort -u | wc -l`;

test('two tabs renaming nested directories at once never hang and keep every file exactly once; unrelated renames do not wait for each other (#1140)', {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  const other = await peerTab(page);
  const dir = '/root/rn';
  const outcomes = new Map();
  for (let round = 0; round < 8; round++) {
    assert.deepEqual(await sh(page, `${tree(`${dir}/t`, FILES)} && rm -rf ${dir}/u`), ok('made\n'));
    const [outer, inner] = await Promise.all([
      sh(page, `mv ${dir}/t ${dir}/u 2>&1; echo $?`),
      sh(other, `mv ${dir}/t/a ${dir}/t/b 2>&1; echo $?`),
    ]);
    const key = `${outer.stdout.trim().split('\n').at(-1)} ${inner.stdout.trim().split('\n').at(-1)}`;
    outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    for (const r of [outer, inner]) {
      assert.match(r.stdout, /^(0|.*No such file or directory[\s\S]*1)\n$/, r.stdout);
    }
    assert.deepEqual(await sh(other, COUNT(dir)), ok(`${FILES}\n${FILES}\n`), `round ${round}`);
  }
  console.log(`nested outcomes: ${JSON.stringify([...outcomes])}`);
  assert.deepEqual(
    await sh(page, `${tree(`${dir}/p`, FILES)} && cp -r ${dir}/p/a ${dir}/p/ab && echo copied`),
    ok('made\ncopied\n')
  );
  const before = [await acks(page), await acks(other)];
  const [left, right] = await Promise.all([
    sh(page, `mv ${dir}/p/a ${dir}/p/a2 && echo moved`),
    sh(other, `mv ${dir}/p/ab ${dir}/p/ab2 && echo moved`),
  ]);
  assert.deepEqual([left, right], [ok('moved\n'), ok('moved\n')]);
  const afterwards = [await acks(page), await acks(other)];
  assert.deepEqual(
    afterwards.map((a, i) => a.waits - before[i].waits),
    [0, 0],
    JSON.stringify({ before, afterwards })
  );
});

test("a peer's exclusive create into the source or the destination of a directory rename lands exactly once or fails cleanly (#1140)", {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  const other = await peerTab(page);
  const dir = '/root/rx';
  for (let round = 0; round < 6; round++) {
    assert.deepEqual(await sh(page, tree(dir, BIG)), ok('made\n'));
    await page.evaluate((d) => {
      window.mv = window.kernel.run(['mv', `${d}/a`, `${d}/b`], { cwd: '/' });
    }, dir);
    await untilFound(page, `${dir.slice(1)}/b/lib`);
    const made = await sh(
      other,
      `set -C; (echo x > ${dir}/a/new) 2>/dev/null; echo "src $?"; (echo y > ${dir}/b/new2) 2>/dev/null; echo "dst $?"`
    );
    assert.equal((await page.evaluate(() => window.mv)).status, 0);
    const [src, dst] = made.stdout
      .trim()
      .split('\n')
      .map((line) => line.split(' ')[1]);
    const found = await sh(
      page,
      `cd ${dir}; ls -d */new */new2 2>/dev/null | sort | tr '\\n' ' '; echo`
    );
    const expect = `${src === '0' ? 'b/new ' : ''}${dst === '0' ? 'b/new2 ' : ''}\n`;
    assert.equal(found.stdout, expect, `round ${round}: ${made.stdout}`);
    const seen = await sh(other, whole(dir));
    assert.ok(wholeAs(BIG)(seen.stdout), seen.stdout);
  }
});

const rootWithModules = (page, dir) =>
  page.evaluate(async (d) => {
    const top = await navigator.storage.getDirectory();
    const copy = async (from, to) => {
      for await (const entry of from.values()) {
        if (entry.kind === 'directory') {
          await copy(entry, await to.getDirectoryHandle(entry.name, { create: true }));
          continue;
        }
        const w = await (await to.getFileHandle(entry.name, { create: true })).createWritable();
        await w.write(await entry.getFile());
        await w.close();
      }
    };
    const root = await top.getDirectoryHandle(d, { create: true });
    await copy(
      await top.getDirectoryHandle('node_modules'),
      await root.getDirectoryHandle('node_modules', { create: true })
    );
  }, dir);

test('a directory rename in one shared OPFS root does not stall the peers of another root on the same origin (#1314)', {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  const other = await peerTab(page);
  await rootWithModules(page, 'rooty');
  for (const tab of [page, other]) {
    await tab.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('rooty', {
        create: true,
      });
      await window.secondKernel({ root }, 'y');
    });
  }
  const shared = async () =>
    Number((await sh(page, 'cat /proc/sys/kernel/slicc_shared_root', 'y')).stdout);
  for (let i = 0; i < 300 && (await shared()) !== 1; i++) await sleep(100);
  assert.equal(await shared(), 1);
  assert.deepEqual(await sh(page, 'mkdir -p /r && echo y > /r/f && echo ok', 'y'), ok('ok\n'));
  const dir = '/root/rs';
  let overlapped = 0;
  for (let round = 0; round < 6 && overlapped < 3; round++) {
    assert.deepEqual(await sh(page, tree(dir, BIG)), ok('made\n'));
    await page.evaluate((d) => {
      window.mvDone = false;
      window.mv = window.kernel.run(['mv', `${d}/a`, `${d}/b`], { cwd: '/' });
      window.mv.then(() => {
        window.mvDone = true;
      });
    }, dir);
    await untilFound(page, `${dir.slice(1)}/b/lib`);
    const r = await sh(other, 'cat /r/f', 'y');
    const during = !(await page.evaluate(() => window.mvDone));
    assert.deepEqual(r, ok('y\n'));
    assert.equal((await page.evaluate(() => window.mv)).status, 0);
    if (during) overlapped++;
  }
  assert.equal(overlapped, 3, 'a call on root y waited for the rename on root x to end');
});

test('a shared root whose metadata name holds an unpaired surrogate still renames a directory (#1339 review)', {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  const other = await peerTab(page);
  await rootWithModules(page, 'rootz');
  for (const tab of [page, other]) {
    await tab.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('rootz');
      await window.secondKernel({ root, metadata: 'z:%\uD800' }, 'z');
    });
  }
  const shared = async () =>
    Number((await sh(page, 'cat /proc/sys/kernel/slicc_shared_root', 'z')).stdout);
  for (let i = 0; i < 300 && (await shared()) !== 1; i++) await sleep(100);
  assert.equal(await shared(), 1);
  assert.deepEqual(
    await sh(
      page,
      'mkdir -p /s/a/lib && echo x > /s/a/lib/f && mv /s/a /s/b && cat /s/b/lib/f',
      'z'
    ),
    ok('x\n')
  );
  assert.deepEqual(await sh(other, 'cat /s/b/lib/f', 'z'), ok('x\n'));
});

const RMTREE = [
  'mkdir -p /node_modules/rmtree',
  `echo '{"name":"rmtree","slicc":{"commands":{"rmtree":{"abi":"js","module":"main.mjs"}}}}' > /node_modules/rmtree/package.json`,
  `echo 'export default async function main(ctx) { await ctx.fs.rm(ctx.argv[1], { recursive: true }); return 0; }' > /node_modules/rmtree/main.mjs`,
  'echo installed',
].join('\n');

test("a peer's removal or rename of the parent of a tree being renamed waits for the rename, so nothing is left half moved (#1338)", {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  const other = await peerTab(page);
  assert.deepEqual(await sh(other, RMTREE), ok('installed\n'));
  const dir = '/root/rp';
  for (const [label, change, left] of [
    ['rm', `rmtree ${dir}/p`, ''],
    ['mv', `mv ${dir}/p ${dir}/q`, `q\n`],
  ]) {
    assert.deepEqual(
      await sh(page, `rm -rf ${dir} && mkdir -p ${dir}/p && echo made`),
      ok('made\n')
    );
    assert.deepEqual(await sh(page, tree(`${dir}/p`, BIG)), ok('made\n'));
    await page.evaluate((d) => {
      window.mv = window.kernel.run(['mv', `${d}/p/a`, `${d}/p/b`], { cwd: '/' });
    }, dir);
    await untilFound(page, `${dir.slice(1)}/p/b/lib`);
    const changed = await sh(other, change);
    const moved = await page.evaluate(() => window.mv);
    assert.equal(changed.status, 0, `${label}: ${changed.stderr}`);
    assert.equal(moved.status, 0, `${label}: mv ${moved.stderr}`);
    assert.deepEqual(await sh(page, `ls -A ${dir}`), ok(left), label);
    if (left) {
      const kept = await sh(page, whole(`${dir}/q`));
      assert.ok(
        wholeAs(BIG)(kept.stdout) && kept.stdout.startsWith('b '),
        `${label}: ${kept.stdout}`
      );
    }
  }
});
