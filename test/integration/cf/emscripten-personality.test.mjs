import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, nodeTransport } from '../../../dist/node.js';
import {
  BASE,
  CURL,
  GIT,
  TERMINAL_STEPS,
  TIER1,
  TIER2,
  TIER2_PACKAGES,
  transcript,
} from './emscripten-cases.mjs';

const modules = new URL('../../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

async function booted(t, mode, packages, options = {}) {
  const kernel = await createNodeKernel({ emscripten: mode, ...options });
  t.after(() => kernel.terminate());
  for (const name of packages) await install(kernel, name);
  return kernel;
}

async function pair(t, packages, options = {}) {
  const [glue, own] = await Promise.all([
    booted(t, 'glue', packages, options),
    booted(t, 'kernel', packages, options),
  ]);
  return { glue, own };
}

const shown = (r) => ({ status: r.status, stdout: r.stdout, stderr: r.stderr });

let serial = 0;

async function same(kernels, script, check) {
  const dir = `/tmp/case${++serial}`;
  const argv = ['bash', '-c', `mkdir -p ${dir} && cd ${dir} && { ${script}\n}`];
  const glue = shown(await kernels.glue.run(argv, { cwd: '/root' }));
  const own = shown(await kernels.own.run(argv, { cwd: '/root' }));
  assert.deepEqual(own, glue, script);
  check?.(own);
}

test('tier 1: bash builtins and coreutils behave the same without the glue', async (t) => {
  const kernels = await pair(t, BASE);
  for (const script of TIER1) await t.test(script, () => same(kernels, script));
});

test('tier 2: pipelines, subshells, jobs, signals and the other packages behave the same', async (t) => {
  const kernels = await pair(t, TIER2_PACKAGES);
  for (const script of TIER2) await t.test(script, () => same(kernels, script));
});

test('tier 3: an interactive bash on a terminal behaves the same', async (t) => {
  const kernels = await pair(t, BASE);
  const glue = await transcript(kernels.glue, TERMINAL_STEPS);
  const own = await transcript(kernels.own, TERMINAL_STEPS);
  assert.deepEqual(own, glue);
  assert.match(own.out, /\^Z\r\n\[1\]\+ +Stopped +sleep 10/);
});

test('tier 3: git init, add, commit and log behave the same', async (t) => {
  const kernels = await pair(t, [...BASE, 'wasm-git']);
  for (const script of GIT) await t.test(script, () => same(kernels, script));
});

async function hostServer(t) {
  const server = createServer((req, res) => {
    res.setHeader('x-test', 'yes');
    res.end(`host says ${req.method} ${req.url}\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://host.slicc.internal:${server.address().port}`;
}

test('tier 3: curl over a host server behaves the same', async (t) => {
  const url = await hostServer(t);
  const transport = nodeTransport({ hostLoopback: true });
  const kernels = await pair(t, [...BASE, 'wasm-curl', 'wasm-tls-engine'], {
    network: { transport },
  });
  for (const script of CURL(url)) await t.test(script, () => same(kernels, script));
});

test('kernel mode never evaluates the package glue', async (t) => {
  const kernel = await booted(t, 'kernel', BASE);
  for (const name of ['wasm-bash/bin/bash', 'wasm-coreutils/bin/coreutils']) {
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}`,
      'throw new Error("glue evaluated");\n'
    );
  }
  const r = await kernel.run(['bash', '-c', 'echo $(ls -d /tmp) ok'], { cwd: '/' });
  assert.deepEqual(shown(r), { status: 0, stdout: '/tmp ok\n', stderr: '' });
});

function importing(names) {
  const name = (text) => [text.length, ...new TextEncoder().encode(text)];
  const section = (id, body) => [id, body.length, ...body];
  const imports = [names.length];
  for (const field of names) imports.push(...name('env'), ...name(field), 0, 0);
  return Uint8Array.from([
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    ...section(1, [1, 0x60, 0, 0]),
    ...section(2, imports),
    ...section(5, [1, 0, 1]),
    ...section(7, [1, ...name('memory'), 2, 0]),
  ]);
}

test('a program importing what the kernel does not provide fails with 126 and names the imports', async (t) => {
  const kernel = await booted(t, 'kernel', ['wasm-bash']);
  const pkg = {
    name: 'fake-em',
    slicc: { abi: 'emscripten', commands: { fake: { glue: 'bin/fake', wasm: 'bin/fake.wasm' } } },
  };
  await kernel.writeFile('/node_modules/fake-em/package.json', JSON.stringify(pkg));
  await kernel.writeFile('/node_modules/fake-em/bin/fake', 'var Module = {};\n');
  await kernel.writeFile('/node_modules/fake-em/bin/fake.wasm', importing(['nope', 'also_missed']));
  const r = await kernel.run(['fake'], { cwd: '/' });
  assert.equal(r.status, 126);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /env\.nope, env\.also_missed/);
  assert.doesNotMatch(r.stderr, /LinkError|at /);
});
