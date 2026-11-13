import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createNodeKernel, nodeTransport } from '../../../dist/node.js';
import { installPackage, shown, skip } from './async-wasi-harness.mjs';
import {
  BASE,
  CURL,
  GIT,
  REFUSAL_PACKAGES,
  REFUSALS,
  refusalOptions,
  TERMINAL_STEPS,
  TIER1,
  TIER2,
  TIER2_PACKAGES,
  transcript,
} from './emscripten-cases.mjs';

async function booted(t, options, packages = BASE) {
  const kernel = await createNodeKernel(options);
  t.after(() => kernel.terminate());
  for (const name of packages) await installPackage(kernel, name);
  return kernel;
}

async function pair(t, packages = BASE, options = {}) {
  const [oracle, own] = await Promise.all([
    booted(t, { emscripten: 'glue', ...options }, packages),
    booted(t, { blocking: 'async', emscripten: 'kernel', ...options }, packages),
  ]);
  return { oracle, own };
}

let serial = 0;

async function same(kernels, script) {
  const dir = `/tmp/case${++serial}`;
  const argv = ['bash', '-c', `mkdir -p ${dir} && cd ${dir} && { ${script}\n}`];
  const oracle = shown(await kernels.oracle.run(argv, { cwd: '/root' }));
  const own = shown(await kernels.own.run(argv, { cwd: '/root' }));
  assert.deepEqual(own, oracle, script);
}

test('bash and coreutils on the async host with the kernel personality match the glue on the sync kernel', {
  skip,
}, async (t) => {
  const kernels = await pair(t);
  for (const script of TIER1) await t.test(script, () => same(kernels, script));
});

test('the milestone pipeline runs on the async host', { skip }, async (t) => {
  const kernels = await pair(t);
  const script =
    'echo a | cat; x=$(uname); echo $x; ls / | head -3; for i in 1 2 3; do echo $i; done | wc -l';
  const r = shown(await kernels.own.run(['bash', '-c', script], { cwd: '/root' }));
  assert.deepEqual(r, shown(await kernels.oracle.run(['bash', '-c', script], { cwd: '/root' })));
  assert.deepEqual(r, { status: 0, stdout: 'a\nLinux\nbin\ndev\netc\n3\n', stderr: '' });
});

test('a background job, a subshell and wait on the async host', { skip }, async (t) => {
  const kernels = await pair(t);
  for (const script of [
    'echo data > f; cat f; (sleep 0.1; echo bg) & wait; echo done',
    'sleep 0.05 & p=$!; wait $p; echo "waited $?"; (exit 4) & wait $!; echo $?',
    'trap "echo trapped" USR1; kill -USR1 $$; echo after',
  ]) {
    await t.test(script, () => same(kernels, script));
  }
});

test('tier 2 on the async host with the kernel personality matches the glue', {
  skip,
}, async (t) => {
  const kernels = await pair(t, TIER2_PACKAGES);
  for (const script of TIER2) await t.test(script, () => same(kernels, script));
});

test('tier 3: an interactive bash on a terminal on the async host matches the glue', {
  skip,
}, async (t) => {
  const kernels = await pair(t);
  const oracle = await transcript(kernels.oracle, TERMINAL_STEPS);
  const own = await transcript(kernels.own, TERMINAL_STEPS);
  assert.deepEqual(own, oracle);
});

test('tier 3: git on the async host matches the glue', { skip }, async (t) => {
  const kernels = await pair(t, [...BASE, 'wasm-git']);
  for (const script of GIT) await t.test(script, () => same(kernels, script));
});

test('tier 3: curl on the async host matches the glue', { skip }, async (t) => {
  const server = createServer((req, res) => {
    res.setHeader('x-test', 'yes');
    res.end(`host says ${req.method} ${req.url}\n`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://host.slicc.internal:${server.address().port}`;
  const transport = nodeTransport({ hostLoopback: true });
  const kernels = await pair(t, [...BASE, 'wasm-curl', 'wasm-tls-engine'], {
    network: { transport },
  });
  for (const script of CURL(url)) await t.test(script, () => same(kernels, script));
});

for (const c of REFUSALS) {
  test(`a refused spawn on the async host: ${c.name}`, { skip }, async (t) => {
    const kernel = await booted(
      t,
      { blocking: 'async', emscripten: 'kernel', ...refusalOptions(c.ceiling) },
      REFUSAL_PACKAGES
    );
    const r = shown(await kernel.run(c.argv, { cwd: '/tmp' }));
    assert.equal(r.status, c.status, r.stderr);
    assert.equal(r.stdout, c.stdout);
    assert.match(r.stderr, c.stderr);
  });
}
