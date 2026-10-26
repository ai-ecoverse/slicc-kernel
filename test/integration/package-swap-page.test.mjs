import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';
import { PAIR_FILES, PAIR_ROOT } from './pair-package.mjs';

const chrome = await launch();
after(() => chrome.close());

const ASIDE = `${PAIR_ROOT}_pacquet-stage_1`;
const STAGE = `${PAIR_ROOT}_pacquet-stage_2`;
const LOCK = `slicc-kernel-replacing:v1:slicc-kernel:${PAIR_ROOT}`;
const SWAP = ['swapper', PAIR_ROOT, ASIDE, STAGE];

const SWAPPER = `export default async function main(ctx) {
  const [, dir, aside, stage] = ctx.argv;
  await ctx.fs.rename(dir, aside);
  await ctx.umask();
  await ctx.fs.rename(stage, dir);
  await ctx.fs.rm(aside, { recursive: true });
}
`;

async function stage(page) {
  const files = [
    ...PAIR_FILES(1).map(([file, data]) => [`${PAIR_ROOT}/${file}`, data]),
    ...PAIR_FILES(2).map(([file, data]) => [`${STAGE}/${file}`, data]),
    [
      '/node_modules/swapper/package.json',
      JSON.stringify({
        name: 'swapper',
        slicc: { commands: { swapper: { abi: 'js', module: 'swap.mjs' } } },
      }),
    ],
    ['/node_modules/swapper/swap.mjs', SWAPPER],
  ].map(([path, data]) => [path.slice(1), typeof data === 'string' ? data : [...data]]);
  await page.evaluate(
    async (list, trees) => {
      for (const [path, data] of list) {
        await window.opfs.write(path, typeof data === 'string' ? data : new Uint8Array(data));
      }
      const { postFsNotice } = await import('/dist/meta.js');
      postFsNotice({ trees });
      return true;
    },
    files,
    [PAIR_ROOT, STAGE, '/node_modules/swapper']
  );
}

const run = (page, argv, kernel = 'kernel') =>
  page.evaluate((a, k) => window[k].run(a, { cwd: '/' }), argv, kernel);

function pendingOn(tab, mode, settled) {
  return tab.evaluate(
    async (lock, want, done) => {
      for (let i = 0; i < 300; i++) {
        const { pending = [] } = await navigator.locks.query();
        if (pending.some((l) => l.name === lock && l.mode === want)) return 'pending';
        if (done && window[done] !== undefined) return 'finished';
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return 'neither';
    },
    LOCK,
    mode,
    settled
  );
}

test("a tab holding a package's shared lock parks the kernel's swap of it before the rename aside, and an exec queued behind the swap gets the new pair, never a mix (#1705, slicc-bios#663)", async (t) => {
  const { page } = await booted(chrome, t);
  await stage(page);
  assert.equal((await run(page, ['pairtest'])).status, 1);
  const tab = await page.tab();
  await tab.goto('/');
  await tab.until(() => typeof window.opfs === 'object');
  await tab.evaluate(async (lock) => {
    const gate = Promise.withResolvers();
    const held = Promise.withResolvers();
    window.releaseShared = gate.resolve;
    navigator.locks.request(lock, { mode: 'shared' }, () => {
      held.resolve();
      return gate.promise;
    });
    await held.promise;
    return true;
  }, LOCK);
  await page.evaluate((argv) => {
    window.swapDone = undefined;
    window.swapRun = window.kernel.run(argv, { cwd: '/' }).then((r) => (window.swapDone = r));
    return true;
  }, SWAP);
  const parked = await pendingOn(tab, 'exclusive');
  const files = await tab.evaluate(
    async (dir, staged) => {
      const host = await window.opfs.read(`${dir.slice(1)}/host/pair.mjs`);
      return { host: host?.includes('v1') ? 'v1' : host, staged: await window.opfs.exists(staged) };
    },
    PAIR_ROOT,
    `${STAGE.slice(1)}/package.json`
  );
  await page.evaluate(() => {
    window.pairDone = undefined;
    window.pairRun = window.kernel
      .run(['pairtest'], { cwd: '/' })
      .then((r) => (window.pairDone = r));
    return true;
  });
  const queued = await pendingOn(page, 'shared', 'pairDone');
  await tab.evaluate(() => {
    window.releaseShared();
    return true;
  });
  assert.equal(parked, 'pending');
  assert.deepEqual(files, { host: 'v1', staged: true });
  assert.equal(queued, 'pending');
  assert.deepEqual(await page.evaluate(() => window.pairRun), {
    status: 2,
    stdout: '',
    stderr: '',
  });
  assert.equal((await page.evaluate(() => window.swapRun)).status, 0);
  assert.equal((await run(page, ['pairtest'])).status, 2);
});

test("an exec in a peer kernel between the two renames of the other kernel's swap waits on the package's lock and gets the new pair, never ENOENT (#1705)", async (t) => {
  const { page } = await booted(chrome, t, { worker: '/swap/pause-worker.js' });
  await stage(page);
  await page.evaluate(() => window.secondKernel({}, 'peer'));
  t.after(() => page.evaluate(() => window.peer?.terminate?.()).catch(() => {}));
  assert.equal((await run(page, ['pairtest'], 'peer')).status, 1);
  await page.evaluate(() => {
    window.shellDone = undefined;
    window.shell = window.peer
      .run(
        [
          'bash',
          '-c',
          ': > /tmp/swap-ready; until [ -e /tmp/swap-go ]; do :; done; pairtest; echo "pairtest $?"',
        ],
        { cwd: '/' }
      )
      .then((r) => (window.shellDone = r));
    return true;
  });
  await page.until(() => window.opfs.exists('tmp/swap-ready'));
  await page.evaluate(async (argv) => {
    const channel = new BroadcastChannel('swap-pause');
    const heard = (word) =>
      new Promise((resolve) => {
        channel.onmessage = ({ data }) => data === word && resolve();
      });
    const armed = heard('armed');
    channel.postMessage('arm');
    await armed;
    const paused = heard('paused');
    window.swapRun = window.kernel.run(argv, { cwd: '/' });
    await paused;
    channel.close();
    return true;
  }, SWAP);
  await page.evaluate(async () => {
    const { postFsNotice } = await import('/dist/meta.js');
    await window.opfs.write('tmp/swap-go', '');
    postFsNotice({ paths: ['/tmp/swap-go', '/tmp'] });
    return true;
  });
  const seen = await pendingOn(page, 'shared', 'shellDone');
  await page.evaluate(() => {
    const channel = new BroadcastChannel('swap-pause');
    channel.postMessage('release');
    channel.close();
    return true;
  });
  assert.deepEqual(await page.evaluate(() => window.shell), {
    status: 0,
    stdout: 'pairtest 2\n',
    stderr: '',
  });
  assert.equal(seen, 'pending');
  assert.equal((await page.evaluate(() => window.swapRun)).status, 0);
});
