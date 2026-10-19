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
  await sh('mkdir -p /tmp/oo');
  return sh;
}

const py = (lines) =>
  `python3 -c "$(echo ${Buffer.from(['import os', ...lines].join('\n')).toString('base64')} | base64 -d)"`;

const N = 60;

const COUNTERS =
  "[int(open(f'/proc/sys/kernel/{n}').read()) for n in ('slicc_opfs_calls', 'slicc_opfs_ops')]";

const KNOWN =
  "[int(open(f'/proc/sys/kernel/{n}').read()) if os.path.exists(f'/proc/sys/kernel/{n}') else 0 for n in ('slicc_opfs_calls', 'slicc_opfs_ops')]";

test('/proc/sys/kernel/slicc_opfs_ops counts every request the root file system makes of OPFS, lookups and the reads, writes, creates, listings, renames and removals that slicc_opfs_calls leaves out (#1017)', {
  timeout: 180_000,
}, async (t) => {
  const sh = await booted(t);
  const steps = [
    ['create', "os.close(os.open('/tmp/oo/f', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o644))"],
    ['write', "fd = os.open('/tmp/oo/f', os.O_WRONLY); os.write(fd, b'abc'); os.close(fd)"],
    ['read', "fd = os.open('/tmp/oo/f', os.O_RDONLY); os.read(fd, 3); os.close(fd)"],
    ['mkdir', "os.mkdir('/tmp/oo/d')"],
    ['list', "os.listdir('/tmp/oo/d')"],
    ['rename', "os.rename('/tmp/oo/f', '/tmp/oo/g')"],
    ['remove', "os.unlink('/tmp/oo/g')"],
  ];
  const r = await sh(
    py([
      'seen = []',
      ...steps.flatMap(([name, line]) => [
        `a = ${COUNTERS}`,
        line,
        `b = ${COUNTERS}`,
        `seen.append('${name} %d %d' % (b[0] - a[0], b[1] - a[1]))`,
      ]),
      "print('\\n'.join(seen))",
    ])
  );
  assert.equal(r.status, 0, r.stderr);
  for (const line of r.stdout.trim().split('\n')) {
    const [name, calls, ops] = line.split(' ');
    assert.ok(Number(ops) >= 1, `${name}: ${ops} OPFS requests`);
    assert.ok(Number(ops) >= Number(calls), `${name}: ${ops} requests but ${calls} lookups`);
  }
});

test('a file a WASI program creates and writes reuses the handle its create made: per file 2 OPFS lookups with O_EXCL, 3 with a write, 4 with O_TRUNC and a write (#1017)', {
  timeout: 180_000,
}, async (t) => {
  const sh = await booted(t);
  const rows = [
    [
      'O_EXCL',
      2.5,
      3.3,
      ["os.close(os.open(f'/tmp/oo/TAG{i}', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o644))"],
    ],
    [
      'O_EXCL + write',
      3.9,
      6.05,
      [
        "fd = os.open(f'/tmp/oo/TAG{i}', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o644)",
        "os.write(fd, b'x' * 4096)",
        'os.close(fd)',
      ],
    ],
    [
      'O_TRUNC + write',
      4.9,
      7.05,
      [
        "fd = os.open(f'/tmp/oo/TAG{i}', os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o644)",
        "os.write(fd, b'x' * 4096)",
        'os.close(fd)',
      ],
    ],
  ];
  const seen = [];
  for (const [k, [name, lookups, requests, body]] of rows.entries()) {
    const r = await sh(
      py([
        'least = None',
        'for r in range(5):',
        `  a = ${KNOWN}`,
        `  for i in range(${N}):`,
        ...body.map((line) => `    ${line.replace('TAG', `r${k}_{r}_`)}`),
        `  b = ${KNOWN}`,
        '  d = [y - x for x, y in zip(a, b)]',
        '  least = d if least is None else [min(p, q) for p, q in zip(least, d)]',
        "print(' '.join(str(v) for v in least))",
      ])
    );
    assert.equal(r.status, 0, r.stderr);
    const [calls, ops] = r.stdout
      .trim()
      .split(' ')
      .map((v) => Number(v) / N);
    seen.push(`${name} ${calls.toFixed(2)}/${ops.toFixed(2)}`);
    assert.ok(calls <= lookups, `${name}: ${calls} OPFS lookups per file`);
    assert.ok(ops <= requests, `${name}: ${ops} OPFS requests per file`);
  }
  console.log(`OPFS lookups/requests per created file: ${seen.join(', ')}`);
});
