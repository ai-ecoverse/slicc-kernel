import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asyncProcessEntry } from '../../../dist/async-process.js';
import { createNodeKernel } from '../../../dist/node.js';
import { installPackage, shown, skip } from './async-wasi-harness.mjs';

async function realm(t) {
  const kernel = await createNodeKernel({
    blocking: 'async',
    emscripten: 'kernel',
    asyncProcess: { inline: asyncProcessEntry },
  });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasi-ripgrep', 'wasix-python']) {
    await installPackage(kernel, name);
  }
  return kernel;
}

test('several processes share one JavaScript realm: pipelines, fork and concurrent runs on the inline async host', {
  skip,
}, async (t) => {
  const kernel = await realm(t);
  await kernel.writeFile('/work/a.txt', 'needle one\nhay\n');
  await kernel.writeFile('/work/b.txt', 'hay\nneedle two\n');
  const script =
    'echo a | cat; x=$(uname); echo $x; ls / | head -3; for i in 1 2 3; do echo $i; done | wc -l; rg --sort path needle /work | wc -l';
  const runs = await Promise.all([
    kernel.run(['bash', '-c', script], { cwd: '/work' }),
    kernel.run(['bash', '-c', script], { cwd: '/work' }),
    kernel.run(
      [
        'python',
        '-c',
        'import os\npid = os.fork()\nif pid == 0:\n  os._exit(4)\nprint(os.waitpid(pid, 0)[1] >> 8)',
      ],
      { cwd: '/work', env: { PYTHON_FORK: 'true' } }
    ),
  ]);
  assert.deepEqual(shown(runs[0]), shown(runs[1]));
  assert.equal(runs[0].status, 0);
  assert.match(runs[0].stdout, /^a\nLinux\nbin\ndev\netc\n3\n2\n$/);
  assert.deepEqual(shown(runs[2]), { status: 0, stdout: '4\n', stderr: '' });
});
