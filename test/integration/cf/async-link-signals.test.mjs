import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  asyncKernel,
  clientOf,
  MODE_NAMES,
  MODES,
  spawnReady,
  within,
} from './async-link-kernel.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const mode of MODES) {
  describe(`signals over ${MODE_NAMES[mode]}`, () => {
    let kernel;
    let client;
    before(async () => {
      kernel = await asyncKernel(mode);
      client = await clientOf(kernel);
    });
    after(() => {
      client.close?.();
      kernel.terminate();
    });

    test('a signal sent while the process waits in a syscall interrupts it', async () => {
      const { proc, ready, out } = await spawnReady(client, ['fake', 'sigwait']);
      await within(ready, 5000, 'ready');
      await proc.signal('SIGUSR1');
      const ended = await within(proc.ended, 5000, 'ended');
      assert.deepEqual(ended, { status: 0 });
      assert.equal(out(), 'ready\nEINTR USR1\n');
    });

    test('a signal sent between syscalls reaches the local header', async () => {
      const { proc, ready, out } = await spawnReady(client, ['fake', 'sigspin']);
      await within(ready, 5000, 'ready');
      await pause(30);
      await proc.signal('SIGUSR1');
      const ended = await within(proc.ended, 5000, 'ended');
      assert.deepEqual(ended, { status: 0 });
      assert.equal(out(), 'ready\nok USR1 then slept once\n');
    });

    test('the same signal raised again after it was taken arrives again', async () => {
      const { proc, ready, out } = await spawnReady(client, ['fake', 'twice']);
      await within(ready, 5000, 'ready');
      await proc.signal('SIGUSR1');
      for (let i = 0; i < 100 && !out().includes('got 1'); i++) await pause(10);
      await proc.signal('SIGUSR1');
      const ended = await within(proc.ended, 5000, 'ended');
      assert.deepEqual(ended, { status: 0 });
      assert.equal(out(), 'ready\ngot 1\ngot 2\n');
    });

    test('stop and continue reach the process', async () => {
      const { proc, ready, out } = await spawnReady(client, ['fake', 'stopwatch']);
      await within(ready, 5000, 'ready');
      await proc.signal('SIGSTOP');
      await pause(50);
      await proc.signal('SIGCONT');
      const ended = await within(proc.ended, 5000, 'ended');
      assert.deepEqual(ended, { status: 0 });
      assert.equal(out(), 'ready\nstop ok continue ok\n');
    });

    for (const [name, argv] of [
      ['in a syscall', ['fake', 'hang']],
      ['between syscalls', ['fake', 'idle']],
    ]) {
      test(`SIGKILL ends a process waiting ${name} without the grace period`, async () => {
        const { proc, ready } = await spawnReady(client, argv);
        await within(ready, 5000, 'ready');
        const start = performance.now();
        await proc.signal('SIGKILL');
        const ended = await within(proc.ended, 5000, 'ended');
        assert.deepEqual(ended, { status: 137, signal: 'SIGKILL' });
        assert.ok(performance.now() - start < 1500, `took ${performance.now() - start} ms`);
      });
    }

    test('SIGTERM with the default action ends the process', async () => {
      const { proc, ready } = await spawnReady(client, ['fake', 'hang']);
      await within(ready, 5000, 'ready');
      await proc.signal('SIGTERM');
      const ended = await within(proc.ended, 5000, 'ended');
      assert.deepEqual(ended, { status: 143, signal: 'SIGTERM' });
    });
  });
}
