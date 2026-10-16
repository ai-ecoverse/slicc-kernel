import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('fixtures/forktls/', import.meta.url);

const line = (who, n, side = '') =>
  `${who} close=-1 errno=8 errno-via-pointer=8 local-exec=${10 + n} global-dynamic=${20 + n}${side}`;

async function boot(t, kind) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const file of ['package.json', `bin/forktls-${kind}.wasm`]) {
    await kernel.writeFile(`/node_modules/forktls/${file}`, await readFile(new URL(file, fixture)));
  }
  return kernel;
}

for (const kind of ['pie', 'static']) {
  test(`a forked child of a ${kind} WASIX program reads errno and its thread-locals, in both TLS models (#728)`, async (t) => {
    const kernel = await boot(t, kind);
    assert.deepEqual(await kernel.run([`forktls-${kind}`], { cwd: '/' }), {
      status: 0,
      stdout: [line('parent', 1), line('child', 2), line('parent', 2), ''].join('\n'),
      stderr: '',
    });
  });
}

test('a forked child of a WASIX program reads the thread-locals of a side module its parent loaded (#728)', async (t) => {
  const kernel = await boot(t, 'pie');
  await kernel.writeFile(
    '/usr/lib/libtlsside.so',
    await readFile(new URL('lib/libtlsside.so', fixture))
  );
  assert.deepEqual(await kernel.run(['forktls-pie', '/usr/lib/libtlsside.so'], { cwd: '/' }), {
    status: 0,
    stdout: [
      line('parent', 1, ' side=31'),
      line('child', 2, ' side=32'),
      line('parent', 2, ' side=32'),
      '',
    ].join('\n'),
    stderr: '',
  });
});
