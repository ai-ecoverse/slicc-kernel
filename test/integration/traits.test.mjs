import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachKernel, createNodeKernel } from '../../dist/node.js';

function liveTransport() {
  const extra = {};
  const transport = {
    get traits() {
      return { manualRedirects: false, encodedBodies: false, maxRequestBody: 1024, ...extra };
    },
    fetch: async () => {
      throw new Error('no network in this test');
    },
  };
  return { transport, extra };
}

function exitBecomes(client, exit) {
  return new Promise((resolve) => {
    if (client.transport.traits.exit === exit) return resolve();
    const stop = client.onTraits((traits) => {
      if (traits.exit !== exit) return;
      stop();
      resolve();
    });
  });
}

test('updateTransportTraits re-reads the transport and tells attached clients only when it changed', async (t) => {
  const { transport, extra } = liveTransport();
  const kernel = await createNodeKernel({ network: { transport } });
  t.after(() => kernel.terminate());
  const early = await attachKernel(await kernel.connect());
  t.after(() => early.close());
  assert.equal(early.protocol[1] >= 10, true);
  assert.equal(early.transport.traits.exit, undefined);
  const seen = [];
  const stop = early.onTraits((traits) => seen.push(traits));

  assert.equal(await kernel.updateTransportTraits(), false);
  extra.exit = 'tailscale';
  const told = exitBecomes(early, 'tailscale');
  assert.equal(await kernel.updateTransportTraits(), true);
  await told;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].exit, 'tailscale');
  assert.equal(early.transport.traits.exit, 'tailscale');
  assert.equal(await kernel.updateTransportTraits(), false);

  const late = await attachKernel(await kernel.connect());
  t.after(() => late.close());
  assert.equal(late.transport.traits.exit, 'tailscale');

  stop();
  extra.exit = 'link';
  const both = Promise.all([exitBecomes(early, 'link'), exitBecomes(late, 'link')]);
  assert.equal(await kernel.updateTransportTraits(), true);
  await both;
  assert.equal(late.transport.traits.exit, 'link');
  assert.equal(early.transport.traits.exit, 'link');
  assert.equal(seen.length, 1);
});

test('a kernel without a transport has nothing to update', async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  assert.equal(await kernel.updateTransportTraits(), false);
});
