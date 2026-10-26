import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as meta from '../../dist/meta.js';
import { createNodeKernel, memoryRoot } from '../../dist/node.js';
import { PAIR_FILES, PAIR_ROOT, pairHost, pairWasm } from './pair-package.mjs';

async function put(root, path, data) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(data);
  await writable.close();
}

async function waiting(done) {
  for (let i = 0; i < 500; i++) {
    const { pending = [] } = await navigator.locks.query();
    if (pending.some((lock) => lock.mode === 'shared' && lock.name.includes(PAIR_ROOT)))
      return 'waiting';
    if (done.result) return 'ran';
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return 'neither';
}

const replacingLocks = async () => {
  const { held = [], pending = [] } = await navigator.locks.query();
  return [...held, ...pending].filter((lock) => lock.name.startsWith('slicc-kernel-replacing:'));
};

test('an exec on the same thread as replacing() waits for it, then loads the new wasm with the new imports, never the new wasm with the old ones (#1703)', async (t) => {
  const root = memoryRoot();
  for (const [file, data] of PAIR_FILES(1)) await put(root, `${PAIR_ROOT}/${file}`, data);
  const kernel = await createNodeKernel({ root });
  t.after(() => kernel.terminate());
  assert.equal((await kernel.run(['pairtest'], { cwd: '/' })).status, 1);
  const done = {};
  let exec;
  let seen;
  const steps = async () => {
    await put(root, `${PAIR_ROOT}/bin/pairtest.wasm`, pairWasm(2));
    await new Promise((resolve) => setTimeout(resolve, 200));
    exec = kernel.run(['pairtest'], { cwd: '/' }).then((result) => {
      done.result = result;
      return result;
    });
    seen = await waiting(done);
    await put(root, `${PAIR_ROOT}/host/pair.mjs`, pairHost(2));
  };
  if (typeof meta.replacing === 'function') await meta.replacing([PAIR_ROOT], steps);
  else {
    await steps();
    meta.postFsNotice({ trees: [PAIR_ROOT] });
  }
  assert.deepEqual(await exec, { status: 2, stdout: '', stderr: '' });
  assert.equal(seen, 'waiting');
});

test('replacing() of the package directory its realm already holds throws EDEADLK at once, while one of a package nested in it runs (#1703)', async () => {
  const nested = `${PAIR_ROOT}/node_modules/dep`;
  const result = await meta.replacing([PAIR_ROOT], async () => {
    await assert.rejects(
      meta.replacing([`${PAIR_ROOT}/`], () => 'again'),
      (err) => err.code === 'EDEADLK' && err.message.includes(PAIR_ROOT)
    );
    return meta.replacing([nested], () => 'nested');
  });
  assert.equal(result, 'nested');
  assert.deepEqual(await replacingLocks(), []);
});

test("replacing() passes its task's result and error on, releases on a throw, and refuses a relative path (#1703)", async () => {
  await assert.rejects(
    meta.replacing([PAIR_ROOT], async () => {
      throw new Error('unpack failed');
    }),
    /unpack failed/
  );
  assert.deepEqual(await replacingLocks(), []);
  assert.equal(await meta.replacing([PAIR_ROOT, PAIR_ROOT], async () => 7), 7);
  await assert.rejects(
    meta.replacing(['node_modules/pairtest'], () => 0),
    (err) => err.code === 'EINVAL'
  );
  assert.deepEqual(await replacingLocks(), []);
});
