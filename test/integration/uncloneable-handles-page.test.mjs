import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const WORKER = '/uncloneable-kernel-worker.js';

async function uncloneable(t) {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => typeof window.boot === 'function');
  await page.evaluate(() => import('/uncloneable-handles.js'));
  await page.evaluate((worker) => window.boot({ worker }), WORKER);
  return page;
}

const bash = (page, name, script) =>
  page.evaluate((n, s) => window[n].run(['bash', '-c', s]), name, script);

const folder = async (path) => {
  let dir = await navigator.storage.getDirectory();
  for (const part of path) dir = await dir.getDirectoryHandle(part, { create: true });
  return dir;
};

const nested = (page, name, path) =>
  page.evaluate(
    async (f, n, p, worker) => {
      const pick = new Function(`return (${f})`)();
      return window.secondKernel({ root: await pick(p), worker }, n);
    },
    folder.toString(),
    name,
    path,
    WORKER
  );

test('a browser that cannot clone a handle still boots on the private top', async (t) => {
  const page = await uncloneable(t);
  const clone = await page.evaluate(async () => {
    try {
      new MessageChannel().port1.postMessage(await navigator.storage.getDirectory());
      return 'cloned';
    } catch (err) {
      return err.name;
    }
  });
  assert.equal(clone, 'DataCloneError');
  const r = await bash(page, 'kernel', 'echo up > /f; cat /f');
  assert.deepEqual([r.status, r.stdout], [0, 'up\n']);
});

test('a nested root is reopened by path, with metadata of its own that lasts', async (t) => {
  const page = await uncloneable(t);
  const copied = await bash(
    page,
    'kernel',
    'mkdir -p /a/b /a/c && cp -r /node_modules /a/b/ && cp -r /node_modules /a/c/'
  );
  assert.equal(copied.status, 0, copied.stderr);
  await nested(page, 'first', ['a', 'b']);
  const set = await bash(page, 'first', 'echo one > /p && chmod 640 /p && stat -c %a /p');
  assert.deepEqual([set.status, set.stdout], [0, '640\n']);
  await page.evaluate(() => window.first.terminate());
  await nested(page, 'again', ['a', 'b']);
  assert.equal((await bash(page, 'again', 'stat -c %a /p')).stdout, '640\n');
  await page.evaluate(() => window.again.terminate());
  await nested(page, 'other', ['a', 'c']);
  assert.notEqual((await bash(page, 'other', 'stat -c %a /p')).status, 0);
  await page.evaluate(() => window.other.terminate());
});

test('a folder inserted by path stays in the media store and returns on a remount', async (t) => {
  const page = await uncloneable(t);
  await page.evaluate(async (f) => {
    const pick = new Function(`return (${f})`)();
    await window.kernel.run(['bash', '-c', 'mkdir -p /mnt/x']);
    const mounted = await window.kernel.mount({ type: 'fsa', source: 'none', target: '/mnt/x' });
    await window.kernel.insert('/mnt/x', await pick(['picked']));
    await window.kernel.run(['bash', '-c', 'echo in > /mnt/x/f']);
    await window.kernel.umount('/mnt/x');
    window.remounted = await window.kernel.mount({ ...mounted, source: mounted.source });
  }, folder.toString());
  assert.equal(await page.evaluate(() => window.remounted.state), 'ok');
  assert.equal(await page.evaluate(() => window.opfs.read('picked/f')), 'in\n');
  assert.equal((await bash(page, 'kernel', 'cat /mnt/x/f')).stdout, 'in\n');
});
