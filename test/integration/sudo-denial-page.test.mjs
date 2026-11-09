import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const JUDGE = 'sudo: denied by the approval judge: it looks high-risk.';

test("on the page, createKernel relays the approver's denial message to sudo, extra fields dropped, and a plain deny still reads approval denied", async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => typeof window.boot === 'function');
  await installPackage(page, 'wasm-coreutils');
  await page.evaluate(async (judge) => {
    const { createKernel } = await import('/dist/index.js');
    const answers = {
      judge: { answer: 'deny', message: judge },
      extra: { answer: 'deny', message: judge, details: () => 'not cloneable' },
      plain: 'deny',
      symbol: Symbol('deny'),
    };
    window.kernel = await createKernel({
      root: await navigator.storage.getDirectory(),
      users: 'enforce',
      approve: (req) => answers[req.argv[1]],
    });
    await window.kernel.users.add({ name: 'cone', groups: ['sudo'] });
  }, JUDGE);
  const sudo = (key) =>
    page.evaluate((k) => window.kernel.run(['sudo', 'echo', k], { cwd: '/', user: 'cone' }), key);
  const denied = (line) => ({ status: 1, stdout: '', stderr: `${line}\n` });
  assert.deepEqual(await sudo('judge'), denied(JUDGE));
  assert.deepEqual(await sudo('plain'), denied('sudo: approval denied'));
  assert.deepEqual(await sudo('extra'), denied(JUDGE));
  assert.deepEqual(await sudo('symbol'), denied('sudo: approval denied'));
});

test("on the page, createKernel relays a person's { answer, timestamp: true } to sudo, which opens the window, while a plain 'once' never does", async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => typeof window.boot === 'function');
  await installPackage(page, 'wasm-bash');
  await installPackage(page, 'wasm-coreutils');
  await page.evaluate(async () => {
    const { createKernel } = await import('/dist/index.js');
    window.asked = [];
    window.kernel = await createKernel({
      root: await navigator.storage.getDirectory(),
      users: 'enforce',
      approve: (req) => {
        window.asked.push(req);
        return req.argv[1] === 'person'
          ? { answer: 'once', timestamp: true, extra: () => 'not cloneable' }
          : 'once';
      },
    });
    await window.kernel.users.add({ name: 'cone', groups: ['sudo'] });
  });
  const shell = (word) =>
    page.evaluate(
      (w) =>
        window.kernel.run(['bash', '-c', `sudo echo ${w}; sudo -n true && echo open; :`], {
          cwd: '/',
          user: 'cone',
        }),
      word
    );
  assert.equal((await shell('plain')).stdout, 'plain\n');
  assert.equal((await shell('person')).stdout, 'person\nopen\n');
  const asked = await page.evaluate(() => window.asked.map((r) => r.timestamp));
  assert.deepEqual(asked, [true, true]);
});
