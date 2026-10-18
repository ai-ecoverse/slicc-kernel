import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const other = (page, name, script) =>
  page.evaluate((n, s) => window[n].run(['bash', '-c', s], { cwd: '/' }), name, script);

const elsewhere = (page, name, dir) =>
  page.evaluate(
    async (n, d) => {
      const top = await navigator.storage.getDirectory();
      const root = await top.getDirectoryHandle(d, { create: true });
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
      await copy(
        await top.getDirectoryHandle('node_modules'),
        await root.getDirectoryHandle('node_modules', { create: true })
      );
      return window.secondKernel({ root }, n);
    },
    name,
    dir
  );

const locks = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const control = new BroadcastChannel('second-tab-count');
        const id = Math.random();
        control.onmessage = ({ data }) => {
          if (data.from !== 'writer' || data.id !== id) return;
          control.close();
          resolve(data.counts['lock slicc-excl'] ?? 0);
        };
        control.postMessage({ to: 'writer', id });
      })
  );

test('a kernel on another OPFS directory of the same origin is no peer: no shared root and no lock per exclusive create (#1120)', async (t) => {
  const { page, bash } = await booted(chrome, t, { worker: '/count/count-worker.js?k=writer' });
  await elsewhere(page, 'b', 'rootb');
  assert.deepEqual(await other(page, 'b', 'echo up'), ok('up\n'));
  const before = await locks(page);
  assert.deepEqual(
    await bash(
      'cat /proc/sys/kernel/slicc_shared_root; mkdir -p /tmp/rn && for i in $(seq 20); do ( set -C; : > /tmp/rn/f$i ); done && echo made',
      { cwd: '/' }
    ),
    ok('0\nmade\n')
  );
  assert.equal((await locks(page)) - before, 0, 'slicc-excl locks for 20 exclusive creates');
});

test("a chmod in a kernel on another OPFS directory leaves this root's file of the same path as it was (#1120)", async (t) => {
  const { page, bash } = await booted(chrome, t);
  const look = 'stat -c "%a %i" /home/same';
  const mine = await bash(`: > /home/same && chmod 600 /home/same && ${look}`, { cwd: '/' });
  assert.equal(mine.status, 0);
  assert.match(mine.stdout, /^600 \d+\n$/);
  await elsewhere(page, 'b', 'rootc');
  assert.deepEqual(
    await other(
      page,
      'b',
      `mkdir -p /home && : > /home/same && chmod 640 /home/same && stat -c %a /home/same`
    ),
    ok('640\n')
  );
  assert.deepEqual(await bash(look, { cwd: '/' }), ok(mine.stdout));
  assert.deepEqual(await other(page, 'b', 'stat -c %a /home/same'), ok('640\n'));
});

test("the origin's own OPFS root keeps its sidecar records across a reload (#1120)", async (t) => {
  const { page, bash } = await booted(chrome, t);
  const look = 'stat -c "%a %i" /home/kept';
  const before = await bash(`: > /home/kept && chmod 604 /home/kept && ${look}`, { cwd: '/' });
  assert.match(before.stdout, /^604 \d+\n$/);
  await page.reload();
  await page.until(() => typeof window.boot === 'function');
  await page.evaluate(() => window.boot({}));
  assert.deepEqual(await bash(look, { cwd: '/' }), ok(before.stdout));
});

test("kernels on the origin's own root, passed explicitly or not, still peer (#1120)", async (t) => {
  const { page, bash } = await booted(chrome, t);
  await page.evaluate(async () =>
    window.secondKernel({ root: await navigator.storage.getDirectory() }, 'b')
  );
  assert.deepEqual(await bash('cat /proc/sys/kernel/slicc_shared_root', { cwd: '/' }), ok('1\n'));
  assert.deepEqual(
    await other(page, 'b', ': > /home/both && chmod 606 /home/both && echo made'),
    ok('made\n')
  );
  assert.deepEqual(await bash('stat -c %a /home/both', { cwd: '/' }), ok('606\n'));
});
