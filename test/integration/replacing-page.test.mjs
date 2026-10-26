import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';
import { PAIR_FILES, PAIR_MANIFEST, PAIR_ROOT, pairHost, pairWasm } from './pair-package.mjs';

const chrome = await launch();
after(() => chrome.close());

const opfsPath = (file) => `${PAIR_ROOT.slice(1)}/${file}`;

async function install(tab, n) {
  const files = PAIR_FILES(n).map(([file, data]) => [
    opfsPath(file),
    typeof data === 'string' ? data : [...data],
  ]);
  await tab.evaluate(
    async (list, root) => {
      for (const [path, data] of list) {
        await window.opfs.write(path, typeof data === 'string' ? data : new Uint8Array(data));
      }
      const { postFsNotice } = await import('/dist/meta.js');
      postFsNotice({ trees: [root] });
      return true;
    },
    files,
    PAIR_ROOT
  );
}

async function installer(page) {
  const tab = await page.tab();
  await tab.goto('/');
  await tab.until(() => typeof window.opfs === 'object');
  return tab;
}

function startReplacing(tab, { hang = false } = {}) {
  return tab.evaluate(
    async (root, wasm, host, wasmPath, hostPath, forever) => {
      const meta = await import('/dist/meta.js');
      const gate = Promise.withResolvers();
      window.releaseReplacing = gate.resolve;
      window.replacingState = 'writing';
      const steps = async () => {
        await window.opfs.write(wasmPath, new Uint8Array(wasm));
        await new Promise((resolve) => setTimeout(resolve, 200));
        window.replacingState = 'paused';
        await (forever ? new Promise(() => {}) : gate.promise);
        await window.opfs.write(hostPath, host);
      };
      window.replaced =
        typeof meta.replacing === 'function'
          ? meta.replacing([root], steps)
          : steps().then(() => meta.postFsNotice({ trees: [root] }));
      await new Promise((resolve) => {
        const poll = () => (window.replacingState === 'paused' ? resolve() : setTimeout(poll, 5));
        poll();
      });
      return true;
    },
    PAIR_ROOT,
    [...pairWasm(2)],
    pairHost(2),
    opfsPath('bin/pairtest.wasm'),
    opfsPath('host/pair.mjs'),
    hang
  );
}

async function startExec(page) {
  await page.evaluate(() => {
    window.pairDone = undefined;
    window.pairRun = window.kernel
      .run(['pairtest'], { cwd: '/' })
      .then((result) => (window.pairDone = result));
    return true;
  });
  return page.until(async (root) => {
    const { pending = [] } = await navigator.locks.query();
    if (pending.some((lock) => lock.mode === 'shared' && lock.name.includes(root)))
      return 'waiting';
    return window.pairDone ? 'ran' : false;
  }, PAIR_ROOT);
}

test('an exec in another tab while replacing() rewrites its package waits, then loads the new wasm with the new imports, never the new wasm with the old ones (#1703)', async (t) => {
  const { page } = await booted(chrome, t);
  await install(page, 1);
  assert.deepEqual(await page.evaluate(() => window.kernel.run(['pairtest'], { cwd: '/' })), {
    status: 1,
    stdout: '',
    stderr: '',
  });
  const other = await installer(page);
  await startReplacing(other);
  const seen = await startExec(page);
  await other.evaluate(async () => {
    window.releaseReplacing();
    await window.replaced;
    return true;
  });
  assert.deepEqual(await page.evaluate(() => window.pairRun), {
    status: 2,
    stdout: '',
    stderr: '',
  });
  assert.equal(seen, 'waiting');
});

test('an exec whose holder tab closes in the middle of replacing() runs with the files as the holder left them, and the lock is gone (#1703)', async (t) => {
  const { page } = await booted(chrome, t);
  await install(page, 1);
  const other = await installer(page);
  await startReplacing(other, { hang: true });
  assert.equal(await startExec(page), 'waiting');
  await other.close();
  assert.deepEqual(await page.evaluate(() => window.pairRun), {
    status: 52,
    stdout: '',
    stderr: '',
  });
  const held = await page.evaluate(async (root) => {
    const { held = [], pending = [] } = await navigator.locks.query();
    return [...held, ...pending].filter((lock) => lock.name.includes(root)).length;
  }, PAIR_ROOT);
  assert.equal(held, 0);
});

test('an exec takes exactly one replacing() lock request, on its package directory (#1703)', async (t) => {
  const { page } = await booted(chrome, t, { worker: '/replacing/count-worker.js' });
  await install(page, 1);
  const run = (argv) => page.evaluate((a) => window.kernel.run(a, { cwd: '/' }), argv);
  const ops = async () => Number((await run(['cat', '/proc/sys/kernel/slicc_opfs_ops'])).stdout);
  assert.equal((await run(['pairtest'])).status, 1);
  const perExec = [];
  for (let i = 0; i < 11; i++) {
    const before = await ops();
    assert.equal((await run(['pairtest'])).status, 1);
    const ran = await ops();
    const idle = await ops();
    perExec.push(ran - before - (idle - ran));
  }
  console.log(`OPFS requests per warm pairtest exec: ${perExec.sort((a, b) => a - b).join(' ')}`);
  const taken = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const counts = new BroadcastChannel('replacing-count');
        counts.onmessage = ({ data }) => {
          counts.close();
          resolve(data.taken);
        };
        counts.postMessage('count');
      })
  );
  const mine = taken.filter((name) => name.endsWith(`:${PAIR_ROOT}`));
  assert.deepEqual(mine, Array(12).fill(`slicc-kernel-replacing:v1:slicc-kernel:${PAIR_ROOT}`));
});

test("a running shell's next exec sees a command an outside writer added to a package's manifest once its notice is posted (#1703)", async (t) => {
  const { page } = await booted(chrome, t);
  await install(page, 1);
  const manifest = JSON.parse(PAIR_MANIFEST);
  manifest.slicc.commands.pairtest2 = manifest.slicc.commands.pairtest;
  await page.evaluate(() => {
    window.shell = window.kernel.run(
      [
        'bash',
        '-c',
        ': > /tmp/pair-ready; until [ -e /tmp/pair-go ]; do :; done; pairtest2; echo "pairtest2 $?"',
      ],
      { cwd: '/' }
    );
    return true;
  });
  await page.until(() => window.opfs.exists('tmp/pair-ready'));
  await page.evaluate(
    async (path, text, root) => {
      const { postFsNotice } = await import('/dist/meta.js');
      await window.opfs.write(path, text);
      postFsNotice({ trees: [root] });
      await window.opfs.write('tmp/pair-go', '');
      postFsNotice({ paths: ['/tmp/pair-go', '/tmp'] });
      return true;
    },
    opfsPath('package.json'),
    JSON.stringify(manifest),
    PAIR_ROOT
  );
  assert.deepEqual(await page.evaluate(() => window.shell), ok('pairtest2 1\n'));
});
