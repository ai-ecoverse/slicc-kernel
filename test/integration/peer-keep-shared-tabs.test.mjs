import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const HOLDER = (dir, tag) =>
  [
    'import os, time',
    `fd = os.open('${dir}/f', os.O_RDWR)`,
    `open('${dir}/opened-${tag}', 'w').close()`,
    `while not os.path.exists('${dir}/go-${tag}'): time.sleep(0.02)`,
    'try:',
    '    print(os.pread(fd, 16, 0).decode().strip())',
    'except OSError as e:',
    "    print(f'errno {e.errno}')",
  ].join('\n');

const steer = (tab, msg) =>
  tab.evaluate(
    (m) =>
      new Promise((resolve) => {
        const channel = new BroadcastChannel('pause-control');
        const seq = Math.random();
        channel.onmessage = ({ data }) => {
          if (data?.done !== seq) return;
          channel.close();
          resolve();
        };
        channel.postMessage({ id: 'h2', seq, ...m });
      }),
    msg
  );

const sharedLeft = (tab) =>
  tab.evaluate(async () => {
    const top = await navigator.storage.getDirectory();
    const dir = await top.getDirectoryHandle('.slicc-unlinked').catch(() => undefined);
    if (!dir) return [];
    const out = [];
    try {
      for await (const [name] of dir.entries()) if (name.startsWith('shared.')) out.push(name);
    } catch (e) {
      if (e?.name === 'NotFoundError') return null;
      throw e;
    }
    return out;
  });

const gone = async (tab) => {
  let left = null;
  for (let i = 0; i < 200; i++) {
    left = await sharedLeft(tab);
    if (left?.length === 0) return [];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return left ?? ['.slicc-unlinked kept vanishing mid-listing'];
};

async function setup(t, dir, second = {}) {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const holder2 = await peerTab(page, second);
  const remover = await peerTab(page);
  assert.deepEqual(
    await sh(page, `rm -rf ${dir} && mkdir -p ${dir} && echo old > ${dir}/f && echo made`),
    ok('made\n')
  );
  for (const [tab, tag] of [
    [page, '1'],
    [holder2, '2'],
  ]) {
    await tab.evaluate(
      (s, n) => {
        window[`holder${n}`] = window.kernel.run(['python3', '-c', s], { cwd: '/' });
      },
      HOLDER(dir, tag),
      tag
    );
    while (!(await page.evaluate((p) => window.opfs.exists(p), `${dir.slice(1)}/opened-${tag}`)))
      await new Promise((resolve) => setTimeout(resolve, 20));
  }
  for (;;) {
    const listed = (await sh(remover, 'cat /proc/sys/kernel/slicc_peer_held')).stdout;
    if (listed.includes(`${dir}/f`)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { page, holder2, remover };
}

test('a file two tabs hold open is kept for both when a third removes it (#1608 b)', {
  timeout: 900_000,
}, async (t) => {
  const dir = '/root/ps1';
  const { page, holder2, remover } = await setup(t, dir);
  assert.deepEqual(await sh(remover, `rm ${dir}/f && echo removed`), ok('removed\n'));
  await sh(page, `: > ${dir}/go-1 && : > ${dir}/go-2`);
  const one = await page.evaluate(() => window.holder1);
  const two = await holder2.evaluate(() => window.holder2);
  console.log(`two holders: ${one.stdout.trim()} / ${two.stdout.trim()}`);
  assert.equal(one.stdout, 'old\n');
  assert.equal(two.stdout, 'old\n');
  assert.deepEqual(await gone(page), [], 'the shared kept file was left behind');
});

test("a file two tabs hold open survives one holder closing while the other's kept is still on its way (#1608 b)", {
  timeout: 900_000,
}, async (t) => {
  const dir = '/root/ps2';
  const { page, holder2, remover } = await setup(t, dir, {
    worker: '/rename/pause-worker.js?id=h2',
  });
  await steer(holder2, { set: { freeze: true } });
  assert.deepEqual(await sh(remover, `rm ${dir}/f && echo removed`), ok('removed\n'));
  await sh(page, `: > ${dir}/go-1`);
  const one = await page.evaluate(() => window.holder1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await steer(holder2, { thaw: true });
  await sh(page, `: > ${dir}/go-2`);
  const two = await holder2.evaluate(() => window.holder2);
  console.log(`first closed, second thawed: ${one.stdout.trim()} / ${two.stdout.trim()}`);
  assert.equal(one.stdout, 'old\n');
  assert.equal(two.stdout, 'old\n');
  assert.deepEqual(await gone(page), [], 'the shared kept file was left behind');
});
