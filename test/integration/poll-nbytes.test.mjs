import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const base = fileURLToPath(new URL('fixtures/npolltest/', import.meta.url));

test('WASIX poll_oneoff reports the bytes really there on a read event, 0 for an empty hung-up pipe, FIFO or AF_UNIX socket (#1053)', async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/npolltest.wasm']) {
    await kernel.writeFile(`/node_modules/npolltest/${file}`, await readFile(join(base, file)));
  }
  const r = await kernel.run(['npolltest'], { cwd: '/' });
  assert.equal(r.stderr, '');
  assert.equal(
    r.stdout,
    [
      'pipe-empty err=0 n=1 nbytes=0 hangup=1',
      'pipe-3 err=0 n=1 nbytes=3 hangup=1',
      'pipe-open-5 err=0 n=1 nbytes=5 hangup=0',
      'fifo-empty err=0 n=1 nbytes=0 hangup=1',
      'fifo-3 err=0 n=1 nbytes=3 hangup=1',
      'unix-empty err=0 n=1 nbytes=0 hangup=1',
      'unix-3 err=0 n=1 nbytes=3 hangup=1',
      '',
    ].join('\n')
  );
});
