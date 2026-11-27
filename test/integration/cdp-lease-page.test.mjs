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
      const pkg = '/node_modules/@ai-ecoverse/slicc-cdp';
      const manifest = await (await fetch(`${pkg}/package.json`)).json();
      const { wasm } = manifest.slicc.commands['playwright-cli'];
      const artifact = await fetch(`${pkg}/${wasm}`);
      if (!artifact.ok) throw new Error('missing published CLI');
      await client.fs.mkdir(`${pkg}/bin`, { recursive: true });
      await client.fs.writeFile(`${pkg}/package.json`, JSON.stringify(manifest));
      await client.fs.writeFile(`${pkg}/${wasm}`, new Uint8Array(await artifact.arrayBuffer()));
      const cli = (...args) => client.run(['playwright-cli', ...args], { cwd: '/' });
      const pending = await cli(
        'lease',
        'request',
        '--allow',
        'https://billing.example',
        '--for',
        '1h'
      );
      const result = await cli('--lease', fixture.lease, 'snapshot');
      const denied = await cli('--lease', fixture.lease, 'click', 'e1');
      await client.close();
      return {
        result,
        pending,
        denied,
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
  assert.deepEqual(result.seen, ['lease:page', 'lease:page']);
  assert.equal(result.pending.status, 0, result.pending.stderr);
  assert.match(
    result.pending.stdout,
    /slicc lease review --to jkt:[A-Za-z0-9_-]{43} --allow https:\/\/billing\.example --for 1h/
  );
  assert.equal(result.denied.status, 1);
  assert.equal(JSON.parse(result.denied.stderr).reason, 'E_UNSUPPORTED');
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.equal(result.result.stdout, 'fixture document\n');
});
