import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, memoryRoot } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function put(root, path, content) {
  const parts = path.split('/').filter(Boolean);
  let dir = root;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  const file = await dir.getFileHandle(parts.at(-1), { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
}

async function install(root, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await put(
      root,
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

const READER = `export default async function main(ctx) {
  try {
    const text = new TextDecoder().decode(ctx.sync.fs.readFile(ctx.argv[1]));
    await ctx.write(1, text);
  } catch (e) {
    await ctx.write(1, (e.code ?? String(e)) + '\\n');
  }
}
`;

const FILES = {
  '/node_modules/reader/package.json': JSON.stringify({
    slicc: { commands: { reader: { abi: 'js', module: 'main.mjs' } } },
  }),
  '/node_modules/reader/main.mjs': READER,
  '/opt/agent/m.mjs': 'export const a = 1;\n',
  '/opt/agent/notes.txt': 'notes\n',
  '/opt/agent/mod.py': 'print("module ran")\n',
  '/node_modules/agent/bin/run': '#!/bin/bash\necho script ran\n',
};

async function kernelWith(onLookup = () => {}) {
  const root = memoryRoot();
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(root, name);
  for (const [path, content] of Object.entries(FILES)) await put(root, path, content);
  const known = new Map(Object.entries(FILES).map(([p, c]) => [p, hash(c)]));
  const denials = [];
  const kernel = await createNodeKernel({
    root,
    onDenial: (d) => denials.push(d),
    protect: {
      paths: ['/opt/agent', '/node_modules/agent'],
      writers: ['bios-installer'],
      integrity: {
        lookup: async (path) => {
          await onLookup(path, root);
          return known.get(path);
        },
      },
    },
  });
  return { kernel, root, denials, known };
}

test('a program reading a tampered source under a protected path is refused: a JS module, a python module and a #! script swapped after its exec check (#454)', async (t) => {
  let swapped = false;
  const { kernel, root, denials } = await kernelWith(async (path, at) => {
    if (path === '/node_modules/agent/bin/run' && !swapped) {
      swapped = true;
      await put(at, path, '#!/bin/bash\necho swapped in after the check\n');
    }
  });
  t.after(() => kernel.terminate());
  const run = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  const before = await run(
    'reader /opt/agent/m.mjs; reader /opt/agent/notes.txt; PYTHONPATH=/opt/agent python3 -c "import mod"'
  );
  assert.equal(before.stdout, 'export const a = 1;\nnotes\nmodule ran\n', before.stderr);
  await put(root, '/opt/agent/m.mjs', 'export const a = 2;\n');
  await put(root, '/opt/agent/notes.txt', 'changed\n');
  await put(root, '/opt/agent/mod.py', 'print("tampered")\n');
  const after = await run(
    'reader /opt/agent/m.mjs; reader /opt/agent/notes.txt; PYTHONPATH=/opt/agent python3 -c "import mod"; echo "py=$?"'
  );
  assert.match(after.stdout, /^EACCES\nchanged\n/);
  assert.doesNotMatch(after.stdout, /tampered/);
  assert.match(after.stdout, /py=1\n$/);
  const script = await run('/node_modules/agent/bin/run; echo "rc=$?"');
  assert.equal(script.stdout, 'rc=126\n', script.stderr);
  assert.match(script.stderr, /\/node_modules\/agent\/bin\/run: Permission denied/);
  assert.deepEqual(
    [...new Set(denials.filter((d) => d.op === 'read-integrity').map((d) => d.path))].sort(),
    ['/node_modules/agent/bin/run', '/opt/agent/m.mjs', '/opt/agent/mod.py']
  );
});

test('a writer reads a changed source unchecked, the next process is refused, and integrity.revoke with the new hash lets it pass (#454)', async (t) => {
  const { kernel, root, known } = await kernelWith();
  t.after(() => kernel.terminate());
  const changed = 'export const a = 3;\n';
  await put(root, '/opt/agent/m.mjs', changed);
  const writer = await kernel.run(['reader', '/opt/agent/m.mjs'], {
    cwd: '/',
    tag: 'bios-installer',
  });
  assert.equal(writer.stdout, changed);
  const other = await kernel.run(['reader', '/opt/agent/m.mjs'], { cwd: '/' });
  assert.equal(other.stdout, 'EACCES\n');
  known.set('/opt/agent/m.mjs', hash(changed));
  await kernel.integrity.revoke('/opt/agent');
  const revoked = await kernel.run(['reader', '/opt/agent/m.mjs'], { cwd: '/' });
  assert.equal(revoked.stdout, changed);
});

test('a protected node script swapped for a pnpm shim that points at an installed kernel command is still refused by its hash (#1453 review)', async (t) => {
  const { kernel, root, denials } = await kernelWith();
  t.after(() => kernel.terminate());
  await put(
    root,
    '/node_modules/reader/package.json',
    JSON.stringify({ slicc: { commands: { run: { abi: 'js', module: 'main.mjs' } } } })
  );
  await put(
    root,
    '/node_modules/agent/bin/run',
    '#!/usr/bin/env node\n// pnpm-wasm-shim={"target":"../../reader/main.mjs"}\n'
  );
  const r = await kernel.run(['bash', '-c', '/node_modules/agent/bin/run; echo "rc=$?"'], {
    cwd: '/',
  });
  assert.equal(r.stdout, 'rc=126\n', r.stderr);
  assert.ok(
    denials.some((d) => d.op === 'read-integrity' && d.path === '/node_modules/agent/bin/run')
  );
});
