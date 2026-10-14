import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, nodeTransport } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

const PROBE_PACKAGE = JSON.stringify({
  name: 'fetchprobe',
  slicc: { commands: { fetchprobe: { abi: 'js', module: 'bin/fetchprobe.mjs' } } },
});

const PROBE = `export default async function main(ctx) {
  try {
    const r = await ctx.fetch(ctx.argv[1]);
    await ctx.write(1, r.status + ' ' + (await r.text()));
  } catch (err) {
    await ctx.write(1, 'error ' + (err.cause?.code ?? err.code ?? err.message));
  }
}
`;

async function hostServer(t) {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.end('host secret\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { port: server.address().port, hits: () => hits };
}

async function kernelWith(t, transport) {
  const kernel = await createNodeKernel({ users: 'off', network: { transport } });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-curl', 'wasm-tls-engine']) await install(kernel, name);
  await kernel.writeFile('/node_modules/fetchprobe/package.json', PROBE_PACKAGE);
  await kernel.writeFile('/node_modules/fetchprobe/bin/fetchprobe.mjs', PROBE);
  return {
    curl: async (port) =>
      (
        await kernel.run(
          ['bash', '-c', `curl -s -w ' %{http_code}' http://host.slicc.internal:${port}/`],
          { cwd: '/' }
        )
      ).stdout,
    fetch: async (url) => (await kernel.run(['fetchprobe', url], { cwd: '/' })).stdout,
  };
}

test("nodeTransport refuses the host's loopback and link-local by default, before connecting", async (t) => {
  const host = await hostServer(t);
  const k = await kernelWith(t, nodeTransport());
  assert.match(
    await k.curl(host.port),
    /refuses the host's loopback 127\.0\.0\.1:\d+ \(see nodeTransport\({ hostLoopback }\)\)\n 403$/
  );
  for (const name of [
    '127.0.0.1',
    'localhost',
    'app.localhost',
    '[::1]',
    '127.1.2.3',
    '[::ffff:127.0.0.1]',
    '2130706433',
  ]) {
    const got = await k.fetch(`http://${name}:${host.port}/`);
    assert.doesNotMatch(got, /host secret/, `${name}: ${got}`);
  }
  assert.doesNotMatch(await k.fetch('http://169.254.169.254/latest/meta-data/'), /^200/);
  assert.equal(host.hits(), 0);
});

test('hostLoopback: true reaches it, but not 9222-9229; a port list allows only those ports', async (t) => {
  const host = await hostServer(t);
  const open = await kernelWith(t, nodeTransport({ hostLoopback: true }));
  assert.equal(await open.curl(host.port), 'host secret\n 200');
  assert.equal(await open.fetch(`http://127.0.0.1:${host.port}/`), '200 host secret\n');
  for (const port of [9222, 9229]) assert.match(await open.curl(port), / 403$/, `${port}`);
  const listed = await kernelWith(t, nodeTransport({ hostLoopback: [host.port] }));
  assert.equal(await listed.curl(host.port), 'host secret\n 200');
  assert.match(await listed.curl(host.port + 1), / 403$/);
  assert.equal(host.hits(), 3);
});
