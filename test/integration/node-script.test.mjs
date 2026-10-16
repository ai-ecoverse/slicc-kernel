import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

const entry = new URL('../../dist/node.js', import.meta.url).href;

const script = `
const { createNodeKernel } = await import(${JSON.stringify(entry)});
const kernel = await createNodeKernel();
console.log('booted');
await kernel.writeFile('/dev/shm/x', 'shm');
console.log(new TextDecoder().decode(await kernel.readFile('/dev/shm/x')));
await kernel.terminate();
console.log('done');
`;

test('a Node script that only boots a kernel, uses /dev/shm and terminates runs to the end and exits', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', script],
    { timeout: 60_000 }
  );
  assert.equal(stdout, 'booted\nshm\ndone\n');
});
