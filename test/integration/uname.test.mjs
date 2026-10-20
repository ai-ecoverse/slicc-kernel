import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

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

async function booted(t, options = {}) {
  const kernel = await createNodeKernel(options);
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  return (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
}

test('uname answers from the kernel: Linux, the hostname, /proc release and version, wasm32', async (t) => {
  const bash = await booted(t);
  const r = await bash(
    'uname -r; cat /proc/sys/kernel/osrelease; uname -s -m; uname -n; uname -v; uname -snrvm'
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    [
      '6.0.0-slicc',
      '6.0.0-slicc',
      'Linux wasm32',
      'slicc',
      '#1 SMP PREEMPT_DYNAMIC',
      'Linux slicc 6.0.0-slicc #1 SMP PREEMPT_DYNAMIC wasm32',
      '',
    ].join('\n')
  );
  const proc = await bash('cat /proc/version');
  assert.match(proc.stdout, /^Linux version 6\.0\.0-slicc .*#1 SMP PREEMPT_DYNAMIC\n$/);
});

test('uname -n is the node name the kernel was given', async (t) => {
  const bash = await booted(t, { hostname: 'box1' });
  const r = await bash('uname -n; cat /etc/hostname');
  assert.equal(r.stdout, 'box1\nbox1\n', r.stderr);
});

test('a WASIX program as a user reads /etc/hostname as the node name, 0644 and root-owned, and a real /etc/hostname in the root wins (#1297)', async (t) => {
  const kernel = await createNodeKernel({ hostname: 'devbox', users: 'enforce' });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  const base = fileURLToPath(new URL('wasix-python/', modules));
  for (const entry of (await readdir(base, { recursive: true, withFileTypes: true })).filter((e) =>
    e.isFile()
  )) {
    const rel = relative(base, join(entry.parentPath, entry.name));
    if (/^lib\/libpython[^/]*\.a$/.test(rel)) continue;
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/wasix-python/${rel}`,
      await readFile(join(entry.parentPath, entry.name))
    );
  }
  await kernel.users.add({ name: 'cone' });
  const probe =
    "python3 -c \"import os; s = os.stat('/etc/hostname'); print(repr(open('/etc/hostname').read()), oct(s.st_mode & 0o777), s.st_uid)\"";
  const synthetic = await kernel.run(['bash', '-c', probe], { cwd: '/home/cone', user: 'cone' });
  assert.equal(synthetic.stdout, "'devbox\\n' 0o644 0\n", synthetic.stderr);
  await kernel.writeFile('/etc/hostname', 'from-the-root\n');
  const real = await kernel.run(['bash', '-c', probe], { cwd: '/home/cone', user: 'cone' });
  assert.equal(real.stdout, "'from-the-root\\n' 0o644 0\n", real.stderr);
});
