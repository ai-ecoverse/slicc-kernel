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
      return n ? window.secondKernel({ root }, n) : true;
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

test('two kernels booting one new OPFS directory at once agree on its id and peer (#1120)', async (t) => {
  const { page } = await booted(chrome, t);
  await elsewhere(page, undefined, 'rootd');
  const shared = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('rootd');
    await Promise.all([window.secondKernel({ root }, 'c'), window.secondKernel({ root }, 'd')]);
    const read = (k) => window[k].run(['cat', '/proc/sys/kernel/slicc_shared_root'], { cwd: '/' });
    return [(await read('c')).stdout, (await read('d')).stdout];
  });
  assert.deepEqual(shared, ['1\n', '1\n']);
});

test("an OPFS directory used as a root before #1120 keeps the modes and inodes it had in the origin's shared records (#1120)", async (t) => {
  const { page, bash } = await booted(chrome, t);
  const look = 'stat -c "%a %i" /home/sub';
  const before = await bash(`: > /home/sub && chmod 640 /home/sub && ${look}`, { cwd: '/' });
  assert.match(before.stdout, /^640 \d+\n$/);
  await page.evaluate(async () => {
    const top = await navigator.storage.getDirectory();
    const root = await top.getDirectoryHandle('rootu', { create: true });
    const home = await root.getDirectoryHandle('home', { create: true });
    await home.getFileHandle('sub', { create: true });
  });
  await elsewhere(page, 'b', 'rootu');
  assert.deepEqual(await other(page, 'b', look), ok(before.stdout));
});

test('the first boot on a used OPFS directory says once that it copied the shared records, and a later boot says nothing (#1120)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(await bash(': > /home/logged && chmod 600 /home/logged', { cwd: '/' }), ok());
  await elsewhere(page, undefined, 'rootw');
  const boots = await page.evaluate(async () => {
    const heard = [];
    const channel = new BroadcastChannel('kernel-warnings');
    channel.onmessage = ({ data }) => heard.push(data);
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('rootw');
    const worker = new URL('/count/warn-worker.js', location.href);
    const counts = [];
    for (const name of ['first', 'later']) {
      await window.secondKernel({ root, worker }, name);
      await window[name].run(['true'], { cwd: '/' });
      await new Promise((r) => setTimeout(r, 200));
      counts.push(heard.splice(0).filter((w) => w.includes('#1120')));
    }
    channel.close();
    return counts;
  });
  assert.equal(boots[0].length, 1, JSON.stringify(boots));
  assert.match(
    boots[0][0],
    /^slicc-kernel: a root not seen before got its own metadata database slicc-kernel:[0-9a-f-]+, a copy of \d+ records of slicc-kernel \(#1120\)$/
  );
  assert.ok(!boots[0][0].includes('/home'), boots[0][0]);
  assert.deepEqual(boots[1], []);
});
