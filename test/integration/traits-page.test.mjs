import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the page re-reads a live traits getter and the kernel worker tells its clients', async (t) => {
  const { page } = await booted(chrome, t, { liveTraits: true });
  const result = await page.evaluate(async () => {
    const client = await window.attachKernel(await window.kernel.connect());
    const seen = [];
    client.onTraits((traits) => seen.push(traits.exit));
    const before = client.transport.traits.exit ?? null;
    const unchanged = await window.kernel.updateTransportTraits();
    window.extraTraits.exit = 'tailscale';
    const changed = await window.kernel.updateTransportTraits();
    for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const late = await window.attachKernel(await window.kernel.connect());
    const result = {
      before,
      unchanged,
      changed,
      seen,
      now: client.transport.traits.exit,
      late: late.transport.traits.exit,
      again: await window.kernel.updateTransportTraits(),
    };
    await client.close();
    await late.close();
    return result;
  });
  assert.deepEqual(result, {
    before: null,
    unchanged: false,
    changed: true,
    seen: ['tailscale'],
    now: 'tailscale',
    late: 'tailscale',
    again: false,
  });
});
