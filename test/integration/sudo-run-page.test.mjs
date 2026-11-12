import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('on the page, kernel.sudoRun runs a request the approver denied, as root, with its output in a file the caller owns, and relays a refusal', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => typeof window.boot === 'function');
  await installPackage(page, 'wasm-bash');
  await installPackage(page, 'wasm-coreutils');
  const result = await page.evaluate(async () => {
    const { createKernel } = await import('/dist/index.js');
    const asked = [];
    const kernel = await createKernel({
      root: await navigator.storage.getDirectory(),
      users: 'enforce',
      approve: (req) => {
        asked.push(req);
        return 'deny';
      },
    });
    await kernel.users.add({ name: 'cone', groups: ['sudo'] });
    const cone = { cwd: '/home/cone', user: 'cone' };
    await kernel.run(['bash', '-c', 'sudo id -u'], { ...cone, tag: 'scoop-x' });
    const [req] = asked;
    const run = await kernel.sudoRun(req, { stdout: '/home/cone/id.out', tag: 'sudo-run:1' });
    const ended = await run.ended;
    const shown = await kernel.run(['bash', '-c', "cat id.out; stat -c '%U %a' id.out"], cone);
    const refused = await kernel.sudoRun({ ...req, uid: 7 }).then(
      () => undefined,
      (err) => [err.code, err.message]
    );
    kernel.terminate();
    return { same: run.pgid === run.pid, ended, out: shown.stdout, refused };
  });
  assert.deepEqual(result, {
    same: true,
    ended: { status: 0 },
    out: '0\ncone 600\n',
    refused: ['EPERM', 'sudo: cone is no longer uid 7'],
  });
});
