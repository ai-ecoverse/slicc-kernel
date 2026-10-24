import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { hostfsProxy } from './hostfs-proxy.mjs';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name, skip) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    const rel = relative(base, file);
    if (skip?.test(rel)) continue;
    await kernel.writeFile(`/node_modules/@ai-ecoverse/${name}/${rel}`, await readFile(file));
  }
}

const WRITER = [
  'import os, time',
  "fd = os.open('f', os.O_RDWR)",
  "open('ready', 'w').close()",
  "while not os.path.exists('go'): time.sleep(0.05)",
  'try:',
  '    os.ftruncate(fd, 0)',
  "    os.pwrite(fd, b'whole', 0)",
  '    os.close(fd)',
  "    print('wrote')",
  'except OSError as e:',
  "    print('errno', e.errno)",
  "open('byname', 'w').write('made')",
].join('\n');

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false
  );

test('a whole-file write-back on a hostfs mount without ranges never makes a file the host removed again (#1498)', {
  timeout: 300_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-wbw-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const proxy = await hostfsProxy({ folders: { project: dir }, pingMs: 100, capabilities: {} });
  t.after(() => proxy.close());
  const kernel = await createNodeKernel({
    hostfs: async (source, { readonly }) => proxy.grant(source, readonly),
  });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await install(kernel, 'wasix-python', /^lib\/libpython[^/]*\.a$/);
  await kernel.writeFile('/mnt/h/.keep', '');
  await kernel.mount({ type: 'hostfs', source: 'project', target: '/mnt/h' });
  await writeFile(join(dir, 'f'), 'abc');
  const running = kernel.run(['python3', '-c', WRITER], { cwd: '/mnt/h' });
  for (let i = 0; i < 400 && !(await exists(join(dir, 'ready'))); i++)
    await new Promise((r) => setTimeout(r, 25));
  await unlink(join(dir, 'f'));
  await writeFile(join(dir, 'go'), '');
  const r = await running;
  const dec = (b) => (typeof b === 'string' ? b : new TextDecoder().decode(b));
  const out = dec(r.stdout);
  console.log(`hostfs: status ${r.status} ${out.trim()} ${dec(r.stderr).trim()}`);
  assert.equal(await exists(join(dir, 'f')), false, 'the write-back made the removed file again');
  assert.equal(await readFile(join(dir, 'byname'), 'utf8'), 'made');
});
