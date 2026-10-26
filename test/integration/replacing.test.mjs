import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as meta from '../../dist/meta.js';
import { createNodeKernel, memoryRoot } from '../../dist/node.js';
import { PAIR_FILES, PAIR_MANIFEST, PAIR_ROOT, pairHost, pairWasm } from './pair-package.mjs';

async function put(root, path, data) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  let dir = root;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(data);
  await writable.close();
}

async function waiting(done, dir = PAIR_ROOT) {
  for (let i = 0; i < 500; i++) {
    const { pending = [] } = await navigator.locks.query();
    if (pending.some((lock) => lock.mode === 'shared' && lock.name.endsWith(`:${dir}`)))
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

const SCRIPT_ROOT = '/node_modules/sealedscript';
const SCRIPT = `${SCRIPT_ROOT}/bin/run`;
const BASH = new URL('../../node_modules/@ai-ecoverse/wasm-bash/', import.meta.url);
const TICKETED = [
  'exec 3<>/dev/sealed',
  'printf %s "$REQ" >&3',
  'read -r reply <&3',
  `t=\${reply#*'"ticket":"'}`,
  `t=\${t%%'"'*}`,
  'exec 3>&-',
  `TOKEN=ph SLICC_SEALED_TICKET=$t exec ${SCRIPT}`,
].join('\n');

async function ticketKernel(t) {
  const root = memoryRoot();
  for (const [file, data] of PAIR_FILES(1)) await put(root, `${PAIR_ROOT}/${file}`, data);
  const other = JSON.parse(PAIR_MANIFEST);
  other.name = 'pairother';
  other.slicc.commands = { pairother: other.slicc.commands.pairtest };
  await put(root, '/node_modules/pairother/package.json', JSON.stringify(other));
  await put(root, '/node_modules/pairother/bin/pairtest.wasm', pairWasm(3));
  await put(root, '/node_modules/pairother/host/pair.mjs', pairHost(3));
  await put(root, `${SCRIPT_ROOT}/package.json`, JSON.stringify({ name: 'sealedscript' }));
  await put(root, SCRIPT, '#!/usr/bin/pairtest\n');
  for (const file of ['package.json', 'bin/bash', 'bin/bash.wasm']) {
    await put(
      root,
      `/node_modules/@ai-ecoverse/wasm-bash/${file}`,
      await readFile(new URL(file, BASH))
    );
  }
  const consumed = [];
  let tickets = 0;
  const sealed = async (req) => {
    if (req.op === 'materialize') return { v: 1, ticket: String(++tickets).padStart(32, '0') };
    if (req.op !== 'materializeConsume') return { v: 1, error: { code: 'EINVAL' } };
    consumed.push(req.interpreters);
    return { values: { TOKEN: 'sekrit' }, placeholders: { TOKEN: 'ph' } };
  };
  const kernel = await createNodeKernel({ root, sealed });
  t.after(() => kernel.terminate());
  const request = JSON.stringify({
    v: 1,
    op: 'materialize',
    argv: [SCRIPT],
    path: SCRIPT,
    cwd: '/',
    names: ['TOKEN'],
  });
  const run = () => kernel.run(['bash', '-c', TICKETED], { cwd: '/', env: { REQ: request } });
  const during = async (shebang) => {
    const done = {};
    let exec;
    let seen;
    const steps = async () => {
      exec = run().then((result) => {
        done.result = result;
        return result;
      });
      seen = await waiting(done, SCRIPT_ROOT);
      await put(root, SCRIPT, shebang);
    };
    if (typeof meta.replacing === 'function') await meta.replacing([SCRIPT_ROOT], steps);
    else await steps();
    return { result: await exec, seen };
  };
  return { run, during, consumed };
}

test('a ticketed exec whose script gets another interpreter while replacing() holds its package is refused with EACCES, so the secret never reaches the new chain (#1703)', async (t) => {
  const { run, during, consumed } = await ticketKernel(t);
  assert.equal((await run()).status, 1);
  const { result, seen } = await during('#!/usr/bin/pairother\n');
  assert.equal(result.status, 126);
  assert.equal(seen, 'waiting');
  assert.deepEqual(consumed, [['/usr/bin/pairtest'], ['/usr/bin/pairtest']]);
});

test('a ticketed exec that waits on replacing() and finds the same chain afterwards runs (#1703)', async (t) => {
  const { during, consumed } = await ticketKernel(t);
  const { result, seen } = await during('#!/usr/bin/pairtest\n');
  assert.equal(result.status, 1);
  assert.equal(seen, 'waiting');
  assert.deepEqual(consumed, [['/usr/bin/pairtest']]);
});
