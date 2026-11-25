import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launch } from './chrome.mjs';

test('the browser worker confirms lease mode and dispatches a WASI call to the dedicated page adapter', async (t) => {
  const chrome = await launch();
  t.after(() => chrome.close());
  const page = await chrome.page(t);
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { CDP_LEASE_VERSION, createKernel, attachKernel } = await import('/dist/index.js');
    const { fixtureAdapter } = await import('/fixtures/lease-adapter.mjs');
    const fixture = await fixtureAdapter();
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(
      crypto.randomUUID(),
      { create: true }
    );
    const tag = 'lease:page';
    const options = {
      root,
      metadata: false,
      media: false,
      ca: false,
      cdpLease: { tag, adapter: fixture.adapter },
    };
    const obsolete = URL.createObjectURL(
      new Blob([`onmessage=({data})=>postMessage({id:data.id,result:!data.cdp})`], {
        type: 'text/javascript',
      })
    );
    const refused = await createKernel({ ...options, worker: obsolete }).then(
      (k) => {
        k.terminate();
        return false;
      },
      (e) => e.message
    );
    URL.revokeObjectURL(obsolete);
    const kernel = await createKernel(options);
    try {
      const client = await attachKernel(await kernel.connect({ tag }));
      await client.fs.mkdir('/node_modules/leaseprobe', { recursive: true });
      for (const file of ['package.json', 'probe.wasm']) {
        const bytes = new Uint8Array(
          await (await fetch(`/fixtures/leaseprobe/${file}`)).arrayBuffer()
        );
        await client.fs.writeFile(`/node_modules/leaseprobe/${file}`, bytes);
      }
      const cmd = {
        id: 1,
        method: 'Slicc.leaseAction',
        params: { lease: fixture.lease, op: 'snapshot', args: {} },
      };
      const result = await client.run(['leaseprobe', 'ws', '', JSON.stringify(cmd)], { cwd: '/' });
      await client.close();
      return {
        result,
        version: CDP_LEASE_VERSION,
        refused,
        seen: fixture.seen.map(({ stamp }) => stamp.tag),
      };
    } finally {
      kernel.terminate();
    }
  });
  assert.equal(result.version, 1);
  assert.match(result.refused, /worker does not support/);
  assert.deepEqual(result.seen, ['lease:page']);
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.deepEqual(JSON.parse(result.result.stdout), [
    { id: 1, result: { result: { text: 'fixture document' } } },
  ]);
});
