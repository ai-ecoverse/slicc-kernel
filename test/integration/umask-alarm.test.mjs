import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

test("a threaded WASIX program's SIGALRM handler that calls umask() and creates a file while the program loops on umask() neither hangs nor loses a mask (#1017)", {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  const fixture = new URL('fixtures/umaskalarm/', import.meta.url);
  for (const file of ['package.json', 'bin/umaskalarm.wasm']) {
    await kernel.writeFile(
      `/node_modules/umaskalarm/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  await kernel.writeFile('/tmp/ua/.keep', '');
  assert.deepEqual(await kernel.run(['umaskalarm', '/tmp/ua'], { cwd: '/' }), {
    status: 0,
    stdout: 'hits enough bad 0 wrong 0 umask 022\n',
    stderr: '',
  });
});

test("a umask an imports module sets through ctx.syscall applies to the program's next create, as one the program sets itself (#1078)", {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  const fixture = new URL('fixtures/umaskimport/', import.meta.url);
  for (const file of ['package.json', 'bin/umaskimport.wasm', 'host/umask-host.mjs']) {
    await kernel.writeFile(
      `/node_modules/umaskimport/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  await kernel.writeFile('/tmp/ui/.keep', '');
  assert.deepEqual(await kernel.run(['umaskimport', '/tmp/ui'], { cwd: '/' }), {
    status: 0,
    stdout: '664 600 700 077\n',
    stderr: '',
  });
});
