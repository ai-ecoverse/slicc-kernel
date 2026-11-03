import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { joined, peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

async function watching(page, paths, recursive) {
  await page.evaluate(
    async (p, r) => {
      window.client ??= await window.attachKernel(await window.kernel.connect());
      window.heard ??= [];
      await window.client.fs.watch(p, { recursive: r }, (change) =>
        window.heard.push(...(change.paths ?? ['overflow']))
      );
    },
    paths,
    recursive
  );
}

const heardUntil = (page, want) =>
  page.evaluate(async (w) => {
    const until = performance.now() + 5000;
    for (;;) {
      const seen = [...new Set(window.heard)].sort();
      if (w.every((path) => seen.includes(path)) || performance.now() > until) {
        window.heard.length = 0;
        return seen;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }, want);

const has = (seen, want) =>
  assert.ok(
    want.every((path) => seen.includes(path)),
    `heard ${JSON.stringify(seen)}, wanted ${JSON.stringify(want)}`
  );

test('a client watch hears what another kernel on the root changes under it, also at paths that did not exist, and what postFsNotice reports', async (t) => {
  const { page } = await booted(chrome, t, { users: 'enforce' });
  assert.deepEqual(await sh(page, 'rm -rf /home/pw /home/quiet && mkdir /home/quiet'), ok());
  const other = await peerTab(page);
  await joined(other);
  await watching(page, ['/home/pw/deep'], true);
  await watching(page, ['/home/quiet'], false);

  assert.deepEqual(await sh(other, 'mkdir -p /home/pw/deep/a && echo x > /home/pw/deep/a/f'), ok());
  has(await heardUntil(page, ['/home/pw/deep/a/f']), [
    '/home/pw',
    '/home/pw/deep',
    '/home/pw/deep/a',
    '/home/pw/deep/a/f',
  ]);
  assert.deepEqual(await sh(other, 'echo more >> /home/pw/deep/a/f'), ok());
  has(await heardUntil(page, ['/home/pw/deep/a/f']), ['/home/pw/deep/a/f']);
  assert.deepEqual(await sh(other, 'mv /home/pw/deep/a /home/pw/deep/b'), ok());
  has(await heardUntil(page, ['/home/pw/deep/a', '/home/pw/deep/b']), [
    '/home/pw/deep/a',
    '/home/pw/deep/b',
  ]);
  assert.deepEqual(await sh(other, 'rm -r /home/pw'), ok());
  has(await heardUntil(page, ['/home/pw']), ['/home/pw']);

  await page.evaluate(async () => {
    const { postFsNotice } = await import('/dist/meta.js');
    postFsNotice({ paths: ['/home/pw/deep/outside'] });
    postFsNotice({ trees: ['/home/pw/deep/tree'] });
  });
  has(await heardUntil(page, ['/home/pw/deep/outside', '/home/pw/deep/tree']), [
    '/home/pw/deep/outside',
    '/home/pw/deep/tree',
  ]);
  const quiet = await page.evaluate(() => window.heard.filter((p) => p.startsWith('/home/quiet')));
  assert.deepEqual(quiet, []);
});

test('mkdir -p by a process reports every directory it creates to a client watch on a missing path', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  assert.deepEqual(await bash('rm -rf /home/mp', { cwd: '/' }), ok());
  await watching(page, ['/home/mp/a/b'], true);
  assert.deepEqual(await bash('mkdir -p /home/mp/a/b/c', { cwd: '/' }), ok());
  has(await heardUntil(page, ['/home/mp/a/b/c']), [
    '/home/mp',
    '/home/mp/a',
    '/home/mp/a/b',
    '/home/mp/a/b/c',
  ]);
});
