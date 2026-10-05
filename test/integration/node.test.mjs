import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, nodeTransport } from '../../dist/node.js';

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

test('a headless kernel in Node runs bash and coreutils on an in-memory root', async () => {
  const kernel = await createNodeKernel({ env: { GREETING: 'hello' } });
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  await kernel.writeFile('/home/in.txt', 'b\na\nc\n');

  const sorted = await kernel.run(
    ['bash', '-c', 'sort /home/in.txt | tr "\\n" " "; echo "$GREETING" > /home/out.txt'],
    {
      cwd: '/home',
    }
  );
  assert.deepEqual(sorted, { status: 0, stdout: 'a b c ', stderr: '' });
  assert.equal(new TextDecoder().decode(await kernel.readFile('/home/out.txt')), 'hello\n');
  assert.deepEqual(
    await kernel.run(['bash', '-c', 'read x; echo "got $x"'], { stdin: 'piped\n' }),
    {
      status: 0,
      stdout: 'got piped\n',
      stderr: '',
    }
  );

  const screen = [];
  const term = await kernel.openTerminal(
    ['bash', '-c', 'echo "tty $(tty -s && echo yes)"; exit 4'],
    { cwd: '/home' }
  );
  term.onData = (bytes) => screen.push(new TextDecoder().decode(bytes));
  assert.equal(await term.exited, 4);
  assert.match(screen.join(''), /tty yes/);

  kernel.terminate();
  await assert.rejects(kernel.run(['bash', '-c', 'true']), /terminated/);
});

test('nodeTransport reaches the registry through the realm proxy, without CORS', async () => {
  const kernel = await createNodeKernel({ network: { transport: nodeTransport() } });
  for (const name of ['wasm-bash', 'wasm-curl', 'wasm-tls-engine']) await install(kernel, name);
  const r = await kernel.run([
    'bash',
    '-c',
    'curl -sS https://registry.npmjs.org/@ai-ecoverse/wasm-bash/latest',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"name":"@ai-ecoverse\/wasm-bash"/);
  kernel.terminate();
});
