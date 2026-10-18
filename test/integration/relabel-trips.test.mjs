import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

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

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  const sh = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  await sh('mkdir -p /mnt/t /tmp/rt && printf x > /tmp/rt/f');
  await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/t' });
  return sh;
}

const py = (lines) =>
  `python3 -c "$(echo ${Buffer.from(['import os', ...lines].join('\n')).toString('base64')} | base64 -d)"`;

const N = 60;
const TRIPS = 2.05;

test('a WASI chmod, fchmod, chown or utime asks the kernel once, without a stat first (#1006)', {
  timeout: 120_000,
}, async (t) => {
  const sh = await booted(t);
  const calls = async () => Number((await sh('cat /proc/sys/kernel/slicc_fs_calls')).stdout);
  const trips = async (n, body) => {
    const before = await calls();
    const r = await sh(
      py([
        "fd = os.open('/tmp/rt/f', os.O_RDWR)",
        `for i in range(${n}):`,
        ...body.map((line) => `  ${line}`),
        'os.close(fd)',
        "print('ok')",
      ])
    );
    assert.deepEqual(r, { status: 0, stdout: 'ok\n', stderr: '' });
    return (await calls()) - before;
  };
  for (const [name, body] of [
    ['chmod', ["os.chmod('/tmp/rt/f', 0o644)"]],
    ['fchmod', ['os.fchmod(fd, 0o644)']],
    ['chown', ["os.chown('/tmp/rt/f', 0, 0)"]],
    ['utime', ["os.utime('/tmp/rt/f', (1, 2))"]],
  ]) {
    const none = await trips(0, ['pass']);
    const many = await trips(N, body);
    const per = (many - none) / N;
    assert.ok(per <= TRIPS, `${name}: ${per} round trips per call`);
  }
});

test('a chmod through one hard link shows in a stat through the other name the same process already has cached (#1006)', {
  timeout: 120_000,
}, async (t) => {
  const sh = await booted(t);
  assert.deepEqual(await sh('printf x > /mnt/t/a && ln /mnt/t/a /mnt/t/b && chmod 600 /mnt/t/a'), {
    status: 0,
    stdout: '',
    stderr: '',
  });
  const r = await sh(
    py([
      "before = oct(os.stat('/mnt/t/b').st_mode & 0o777)",
      "os.chmod('/mnt/t/a', 0o640)",
      "after = oct(os.stat('/mnt/t/b').st_mode & 0o777)",
      "os.utime('/mnt/t/b', (5, 7))",
      "print(before, after, int(os.stat('/mnt/t/a').st_mtime))",
    ])
  );
  assert.deepEqual(r, { status: 0, stdout: '0o600 0o640 7\n', stderr: '' });
});
