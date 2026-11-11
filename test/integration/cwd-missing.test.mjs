import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(base, file)}`,
      await readFile(file)
    );
  }
}

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  return kernel;
}

const GONE = {
  code: 'ENOENT',
  message: 'cannot change to /home/w/clone: No such file or directory',
};

const listed = async (kernel) => (await kernel.run(['ls', '-A', '/home/w'], { cwd: '/' })).stdout;

test("with cwdMissing: 'error', kernel.run and openTerminal in a removed directory reject with ENOENT, start nothing and leave it removed; the default still creates it (#1808)", async (t) => {
  const kernel = await booted(t);
  await kernel.run(['bash', '-c', 'mkdir -p /home/w/clone/.git && rm -rf /home/w/clone'], {
    cwd: '/',
  });
  await assert.rejects(
    kernel.run(['bash', '-c', 'echo ran > /tmp/ran'], {
      cwd: '/home/w/clone',
      cwdMissing: 'error',
    }),
    GONE
  );
  await assert.rejects(
    kernel.openTerminal(['bash'], { cwd: '/home/w/clone', cwdMissing: 'error', onData() {} }),
    GONE
  );
  assert.equal(await listed(kernel), '');
  assert.equal((await kernel.run(['test', '-e', '/tmp/ran'], { cwd: '/' })).status, 1);
  assert.deepEqual(await kernel.run(['pwd'], { cwd: '/home/w', cwdMissing: 'error' }), {
    status: 0,
    stdout: '/home/w\n',
    stderr: '',
  });
  assert.deepEqual(await kernel.run(['pwd'], { cwd: '/home/w/clone', cwdMissing: 'create' }), {
    status: 0,
    stdout: '/home/w/clone\n',
    stderr: '',
  });
  assert.equal(await listed(kernel), 'clone\n');
  await assert.rejects(kernel.run(['pwd'], { cwd: '/', cwdMissing: 'fail' }), TypeError);
});

test("a client's spawn and run with cwdMissing: 'error' in a repository removed since reject with ENOENT instead of bringing it back empty (#1808)", async (t) => {
  const kernel = await booted(t);
  const client = await attachKernel(await kernel.connect(), { locks: null });
  t.after(() => client.close());
  await client.run(['bash', '-c', 'mkdir -p /home/w/clone/.git && rm -rf /home/w/clone'], {
    cwd: '/',
  });
  await assert.rejects(client.spawn(['pwd'], { cwd: '/home/w/clone', cwdMissing: 'error' }), GONE);
  await assert.rejects(client.run(['pwd'], { cwd: '/home/w/clone', cwdMissing: 'error' }), GONE);
  await assert.rejects(
    client.openTerminal(['bash'], { cwd: '/home/w/clone', cwdMissing: 'error' }),
    GONE
  );
  assert.equal(await listed(kernel), '');
  const made = await client.run(['pwd'], { cwd: '/home/w/clone' });
  assert.equal(made.stdout, '/home/w/clone\n');
  assert.equal(await listed(kernel), 'clone\n');
});

test("against a kernel before protocol 1.14, which would create the directory, a client's cwdMissing: 'error' rejects with ENOSYS before sending anything", async () => {
  const { port1, port2 } = new MessageChannel();
  const sent = [];
  port2.onmessage = ({ data }) => {
    if (data.hello) port2.postMessage({ hello: { protocol: [1, 13] } });
    else sent.push(data.op);
  };
  const client = await attachKernel(port1, { locks: null });
  try {
    for (const start of [
      () => client.spawn(['pwd'], { cwd: '/gone', cwdMissing: 'error' }),
      () => client.run(['pwd'], { cwd: '/gone', cwdMissing: 'error' }),
      () => client.openTerminal(['bash'], { cwd: '/gone', cwdMissing: 'error' }),
    ])
      await assert.rejects(start(), { code: 'ENOSYS' });
    assert.deepEqual(sent, []);
  } finally {
    client.close();
    port1.close();
    port2.close();
  }
});
