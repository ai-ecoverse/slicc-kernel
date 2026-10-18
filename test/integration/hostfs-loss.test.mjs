import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const ORIGIN = 'http://localhost:8787';

async function install(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(base, file)}`,
      await readFile(file)
    );
  }
}

test('hostfs from Node against slicc-node: a writer whose proxy goes away mid-write fails instead of 0, its later writes fail, and a fresh write after the loss fails too (#1062)', {
  timeout: 900_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-loss-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const proxy = await startProxy({
    port: 0,
    origins: [ORIGIN],
    mounts: [`${dir}:project`],
    kernelPort: null,
  });
  let up = true;
  t.after(() => up && proxy.close());
  const hostfs = async (mount, { readonly }) => {
    const response = await fetch(`${proxy.url}/api/hostfs/grant`, {
      method: 'POST',
      headers: { 'X-Bridge-Token': proxy.key, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mount, readonly }),
    });
    const { token, capabilities } = await response.json();
    return { url: proxy.url, token, capabilities };
  };
  const kernel = await createNodeKernel({ hostfs, hostfsOrigin: ORIGIN });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile('/mnt/h/.keep', '');
  await kernel.mount({ type: 'hostfs', source: 'project', target: '/mnt/h' });
  const writer = kernel.run(
    [
      'bash',
      '-c',
      '( for i in $(seq 1 300000); do echo line-$i || exit 3; done ) > /mnt/h/w.txt; echo "writer $?"',
    ],
    { cwd: '/' }
  );
  const on = () =>
    stat(join(dir, 'w.txt')).then(
      (s) => s.size,
      () => -1
    );
  while ((await on()) <= 0) await new Promise((r) => setTimeout(r, 20));
  up = false;
  await proxy.close();
  const r = await writer;
  assert.equal(r.stdout, 'writer 3\n', r.stderr.slice(0, 300));
  assert.match(r.stderr, /write error/);
  const fresh = await kernel.run(['bash', '-c', 'echo data > /mnt/h/fresh.txt; echo "fresh $?"'], {
    cwd: '/',
  });
  assert.equal(fresh.stdout, 'fresh 1\n');
});
