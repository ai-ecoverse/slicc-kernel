import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const opts = { cwd: '/' };
const BUSY = (cmd) => `${cmd}: cannot remove '/tmp/locked/a': Resource busy\n`;

async function watching(page) {
  await page.evaluate(async () => {
    const client = await window.attachKernel(await window.kernel.connect());
    window.heard = [];
    window.closing = await client.fs.watch(['/tmp/locked', '/home'], { recursive: true }, (c) =>
      window.heard.push(c)
    );
  });
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return page.evaluate(() => window.heard.splice(0));
  };
}

test('on OPFS a locked file fails rm -f with EBUSY, stays, and no watcher hears of it, kept open or not', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  assert.equal((await bash('mkdir -p /tmp/locked && echo data > /tmp/locked/a', opts)).status, 0);
  const quiet = await watching(page);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        window.locker = new Worker('/lock-worker.js');
        window.unlocked = new Promise((done) => {
          window.locker.onmessage = ({ data }) => (data === 'locked' ? resolve() : done());
        });
        window.locker.postMessage({ path: 'tmp/locked/a', ms: 6000 });
      })
  );
  const r = await bash('rm -f -- /tmp/locked/a; echo rc=$?; cat /tmp/locked/a', opts);
  assert.deepEqual(r, { status: 0, stdout: 'rc=1\ndata\n', stderr: BUSY('rm') });
  assert.deepEqual(await quiet(), []);
  const held = await bash('exec 3< /tmp/locked/a; rm -f -- /tmp/locked/a; echo rc=$?', opts);
  assert.deepEqual(held, { status: 0, stdout: 'rc=1\n', stderr: BUSY('rm') });
  assert.deepEqual(await quiet(), []);
  await page.evaluate(() => window.unlocked);
  assert.deepEqual(await bash('rm -f -- /tmp/locked/a; echo rc=$?', opts), {
    status: 0,
    stdout: 'rc=0\n',
    stderr: '',
  });
  assert.deepEqual(await quiet(), [{ paths: ['/tmp/locked/a'] }]);
});

test('on OPFS a command entry with a reader in another process is ENOENT to rm, not EBUSY, and silent', async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  await installPackage(page, 'wasm-coreutils');
  await page.evaluate(() => window.kernel.users.add({ name: 'cone' }));
  const home = '/home/cone/.local/share/pnpm';
  const pkg = `${home}/global/5/g/node_modules/own`;
  const made = await bash(
    `mkdir -p /tmp/locked ${pkg}/bin && printf 'echo own\\n' > ${pkg}/bin/own && echo '{"name":"own","slicc":{"commands":{"own":{"script":"bin/own"}}}}' > ${pkg}/package.json && chown -R cone:cone /home/cone/.local`,
    opts
  );
  assert.equal(made.status, 0, made.stderr);
  const quiet = await watching(page);
  const entry = `${home}/bin/own`;
  const r = await page.evaluate(
    (path) =>
      window.kernel.run(
        [
          'bash',
          '-c',
          `( exec 3< ${path}; touch /tmp/open; while [ ! -e /tmp/stop ]; do sleep 0.05; done ) & until [ -e /tmp/open ]; do sleep 0.05; done; rm -- ${path}; echo rc=$?; touch /tmp/stop; wait; cat ${path}`,
        ],
        { cwd: '/', user: 'cone' }
      ),
    entry
  );
  assert.deepEqual(r, {
    status: 0,
    stdout: 'rc=1\necho own\n',
    stderr: `rm: cannot remove '${entry}': No such file or directory\n`,
  });
  assert.deepEqual(
    (await quiet()).filter((c) => c.paths?.some((p) => p.startsWith(home))),
    []
  );
});
