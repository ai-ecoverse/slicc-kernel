import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('fixtures/guestwrites/', import.meta.url);

test('a threaded WASI program reading files, directories, links, stats, pipes, polls, randomness and its environment into guarded buffers sees no kernel write outside a buffer, past the length it was told, or 200 ms after the call, under signals and timeouts (homescoop#1127)', async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/guestwrites.wasm']) {
    await kernel.writeFile(
      `/node_modules/guestwrites/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  const rounds = Number(process.env.SLICC_GUESTWRITES_ROUNDS ?? 6);
  const runs = [];
  for (let i = 0; i < rounds; i++) {
    await kernel.writeFile(`/tmp/guest-${i}/.keep`, '');
    runs.push(
      kernel.run(['guestwrites', '8', '600'], { cwd: `/tmp/guest-${i}` }).then((r) => ({ i, ...r }))
    );
    if (runs.length === 2) {
      for (const r of await Promise.all(runs.splice(0))) {
        assert.equal(r.status, 0, `round ${r.i}: ${r.stdout}${r.stderr}`);
        assert.match(r.stdout, /^canary: clean, 5280 calls, 5280 checked 200 ms later, /m);
        assert.match(r.stdout, /^canary: answered with data: (\d+ ){9}\d+$/m);
      }
    }
  }
});
