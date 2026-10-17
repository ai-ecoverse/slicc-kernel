import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

const PACKAGE = JSON.stringify({
  name: 'jsfifo',
  slicc: { commands: { jsfifo: { abi: 'js', module: 'bin/jsfifo.mjs' } } },
});

const PROGRAM = `const dec = new TextDecoder();
const enc = new TextEncoder();
export default async function main(ctx) {
  const [mode, path] = ctx.argv.slice(1);
  const say = (line) => ctx.write(1, line + '\\n');
  const code = (p) => p.then(() => 'ok', (e) => e.code ?? e.name);
  if (mode === 'read') {
    const f = await ctx.open(path, { read: true });
    await say('read ' + dec.decode(await f.read(0, 64)).trim() + ' then ' + (await f.read(0, 64)).length);
    await say('seek ' + (await code(f.read(5, 1))) + ' size ' + (await f.size()) + ' fdread ok');
    await f.close();
  } else if (mode === 'write') {
    const f = await ctx.open(path, { write: true });
    await f.write(0, enc.encode('from js\\n'));
    await f.close();
  } else if (mode === 'edge') {
    await say('nonblock write ' + (await code(ctx.open(path, { write: true, nonblock: true }))));
    const r = await ctx.open(path, { read: true, nonblock: true });
    await say('nonblock read ' + (await r.read(0, 8)).length);
    await r.close();
    const ac = new AbortController();
    const waiting = ctx.open(path, { read: true, signal: ac.signal });
    setTimeout(() => ac.abort(new Error('gave up')), 100);
    await say('aborted ' + (await waiting.then(() => 'opened', (e) => e.message)));
    await say('socket ' + (await code(ctx.open('/tmp/s.sock', { read: true }))));
  }
}
`;

test("a JS program's ctx.open of a FIFO meets its writer or reader through the kernel, as fifo(7) says, and a socket node is ENXIO (#935)", {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.writeFile('/node_modules/jsfifo/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/jsfifo/bin/jsfifo.mjs', PROGRAM);
  const sh = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  await sh(
    'mkfifo /tmp/f && python3 -c "import socket; socket.socket(socket.AF_UNIX).bind(\'/tmp/s.sock\')"'
  );
  assert.deepEqual(await sh('(sleep 0.3; echo from bash > /tmp/f) & jsfifo read /tmp/f; wait'), {
    status: 0,
    stdout: 'read from bash then 0\nseek ESPIPE size 0 fdread ok\n',
    stderr: '',
  });
  assert.deepEqual(await sh('(sleep 0.3; jsfifo write /tmp/f) & cat /tmp/f; wait'), {
    status: 0,
    stdout: 'from js\n',
    stderr: '',
  });
  assert.deepEqual(await sh('jsfifo edge /tmp/f'), {
    status: 0,
    stdout: 'nonblock write ENXIO\nnonblock read 0\naborted gave up\nsocket ENXIO\n',
    stderr: '',
  });
  assert.equal((await sh("stat -c '%F %s' /tmp/f")).stdout, 'fifo 0\n');
});
