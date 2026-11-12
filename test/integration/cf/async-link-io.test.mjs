import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { asyncKernel, checksum, MODE_NAMES, MODES } from './async-link-kernel.mjs';

const MIB = 1024 * 1024;

function pattern(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7 + 3) % 256;
  return bytes;
}

for (const mode of MODES) {
  describe(`async link over ${MODE_NAMES[mode]}`, () => {
    let kernel;
    before(async () => {
      kernel = await asyncKernel(mode);
    });
    after(() => kernel.terminate());

    test('the process learns its identity from the kernel', async () => {
      const r = await kernel.run(['fake', 'id']);
      assert.equal(r.status, 0, r.stderr);
      const shown = JSON.parse(r.stdout);
      assert.equal(shown.identity.pid, shown.pid);
      assert.deepEqual(shown.args, ['id']);
      assert.equal(shown.image, 'sha256:');
    });

    test('writes to stdout and stderr and its exit status reaches kernel.run', async () => {
      assert.deepEqual(await kernel.run(['fake', 'out']), {
        status: 7,
        stdout: 'to stdout\n',
        stderr: 'to stderr\n',
      });
    });

    test('reads stdin to the end', async () => {
      const r = await kernel.run(['fake', 'cat'], { stdin: 'line one\nline two\n' });
      assert.deepEqual(r, { status: 0, stdout: 'line one\nline two\n', stderr: '' });
    });

    test('a read answer larger than the SAB window arrives whole', async () => {
      const bytes = pattern(3 * MIB + 12345);
      await kernel.writeFile('/tmp/big', bytes);
      const r = await kernel.run(['fake', 'big', '/tmp/big']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, `${bytes.length} ${checksum(bytes)} ${bytes.length}\n`);
    });

    test('a forked child gets the parent memory', async () => {
      const r = await kernel.run(['fake', 'fork', '4096']);
      assert.equal(r.status, 0, r.stderr);
      const [parent, child] = r.stdout.trim().split('\n');
      assert.equal(child, parent.replace('parent', 'child'));
    });

    test('the change log mirror advances with a write', async () => {
      const r = await kernel.run(['fake', 'changes', '/tmp/changed']);
      assert.deepEqual(r, { status: 0, stdout: 'changes advanced cwds 4096\n', stderr: '' });
    });

    test('the held cwd mirror sees the cwd go away', async () => {
      const r = await kernel.run(['fake', 'cwdgone'], { cwd: `/tmp/gone-${mode}` });
      assert.deepEqual(r, { status: 0, stdout: 'slot current then moved\n', stderr: '' });
    });

    test('sleeps in the kernel', async () => {
      const start = performance.now();
      const r = await kernel.run(['fake', 'sleep', '120']);
      assert.deepEqual(r, { status: 0, stdout: 'slept enough\n', stderr: '' });
      assert.ok(performance.now() - start >= 115);
    });

    test('a blocking read on a pipe is answered later, with two processes at once', async () => {
      const start = performance.now();
      const [piped, slept] = await Promise.all([
        kernel.run(['fake', 'pipe']),
        kernel.run(['fake', 'sleep', '200']),
      ]);
      assert.equal(piped.status, 0, piped.stderr);
      assert.match(piped.stdout, /^late\nchild \[\d+,0\]\n$/);
      assert.deepEqual(slept, { status: 0, stdout: 'slept enough\n', stderr: '' });
      assert.ok(performance.now() - start < 1500);
    });
  });

  describe(`async link over ${MODE_NAMES[mode]} with maxMessageBytes`, () => {
    const max = 256 * 1024;
    let kernel;
    before(async () => {
      kernel = await asyncKernel(mode, { maxMessageBytes: max });
    });
    after(() => kernel.terminate());

    test('an answer larger than maxMessageBytes is split and joined', async () => {
      const bytes = pattern(2 * MIB + 777);
      await kernel.writeFile('/tmp/big', bytes);
      const r = await kernel.run(['fake', 'big', '/tmp/big']);
      assert.equal(r.status, 0, r.stderr);
      const [length, sum, largest] = r.stdout.trim().split(' ').map(Number);
      assert.equal(length, bytes.length);
      assert.equal(sum, checksum(bytes));
      assert.equal(largest, max);
    });

    test('fork memory larger than maxMessageBytes reaches the child', async () => {
      const r = await kernel.run(['fake', 'fork', String(MIB + 5)]);
      assert.equal(r.status, 0, r.stderr);
      const [parent, child] = r.stdout.trim().split('\n');
      assert.match(parent, /^parent 1048581 \d+$/);
      assert.equal(child, parent.replace('parent', 'child'));
    });

    test('a request body larger than maxMessageBytes is staged', async () => {
      const r = await kernel.run(['fake', 'bigwrite', '/tmp/written', String(MIB + 99)]);
      assert.equal(r.status, 0, r.stderr);
      const [length, sum, largest] = r.stdout.trim().split(' ').map(Number);
      const written = await kernel.readFile('/tmp/written');
      assert.equal(written.length, length);
      assert.equal(checksum(written), sum);
      assert.ok(largest <= max, `largest sent ${largest}`);
    });
  });
}
