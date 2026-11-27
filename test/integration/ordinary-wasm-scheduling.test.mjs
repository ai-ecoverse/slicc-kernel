import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpfsFs } from '../../src/fs/opfs.ts';
import { Launcher } from '../../src/launcher.ts';
import { memoryRoot } from '../../src/node/memory-root.ts';
import { messageWasm } from './cf/message-wasm.mjs';

test('ordinary WASI launch starts the image read in the cache-key continuation without a lease-only microtask', async (t) => {
  const fs = new OpfsFs(memoryRoot());
  const launcher = new Launcher({
    fs,
    createWorker: () => assert.fail('the stopped load must not spawn a process'),
  });
  t.after(() => launcher.unmountAll());
  await launcher.prepare();
  const dir = '/node_modules/scheduling';
  const image = `${dir}/test.wasm`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    `${dir}/package.json`,
    JSON.stringify({
      name: 'scheduling',
      slicc: { abi: 'wasi', commands: { scheduling: { wasm: 'test.wasm' } } },
    })
  );
  await fs.writeFile(image, messageWasm('fixture').head);
  const entered = Promise.withResolvers();
  const key = Promise.withResolvers();
  const events = [];
  t.mock.method(launcher, 'cacheKey', (path) => {
    assert.equal(path, image);
    entered.resolve();
    return key.promise;
  });
  t.mock.method(launcher, 'keyed', async (path) => {
    assert.equal(path, image);
    events.push('read');
    throw new Error('stop after observing image read');
  });
  const finished = assert.rejects(
    launcher.run(['scheduling'], { cwd: '/' }),
    /stop after observing image read/
  );
  await entered.promise;
  key.resolve('fixture-key');
  queueMicrotask(() => events.push('next microtask'));
  await finished;
  assert.deepEqual(events, ['read', 'next microtask']);
});
