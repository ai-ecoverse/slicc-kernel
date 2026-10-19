import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('./fixtures/copytest/', import.meta.url);

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

async function kernelWith(t, users = 'enforce', options = {}) {
  const kernel = await createNodeKernel({ users, ...options });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  for (const file of [
    'package.json',
    'bin/copytest.wasm',
    'bin/copyhost.wasm',
    'host/copy-host.mjs',
  ]) {
    await kernel.writeFile(
      `/node_modules/copytest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  return (script) => kernel.run(['bash', '-c', SAME + script], { cwd: '/home' });
}

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

const SAME = 'same() { [ "$(sha256sum < "$1")" = "$(sha256sum < "$2")" ]; }; ';

for (const users of ['off', 'enforce']) {
  test(`slicc_fs.path_copy_file copies a file with the bytes, the mode under the umask and the caller as owner, users ${users} (#1017)`, {
    timeout: 60_000,
  }, async (t) => {
    const bash = await kernelWith(t, users);
    assert.deepEqual(
      await bash(
        'mkdir -p /home/c && head -c 70000 /dev/urandom > /home/c/src && chmod 600 /home/c/src && copytest copy /home/c/src /home/c/a 755 1 && same /home/c/src /home/c/a && stat -c %a /home/c/a && (umask 077; copytest copy /home/c/src /home/c/b 755 1) && stat -c %a /home/c/b && copytest copy /home/c/src /home/c/m 0 3 && stat -c %a /home/c/m'
      ),
      ok('copy /home/c/a: ok\n755\ncopy /home/c/b: ok\n700\ncopy /home/c/m: ok\n600\n')
    );
    assert.deepEqual(
      await bash(
        'cd /home/c && copytest copy src a 644 1; echo x > d0 && copytest copy src d0 644 0 && same src d0 && copytest copy nothere z 644 1; copytest copy src . 644 0; copytest copy src a 644 4; copytest copy src /dev/shm/x 644 1; ls z 2>&1 | head -c 0; test -e z || echo no-z'
      ),
      ok(
        'copy a: File exists\ncopy d0: ok\ncopy z: No such file or directory\ncopy .: Is a directory\ncopy a: Invalid argument\ncopy /dev/shm/x: Cross-device link\nno-z\n'
      )
    );
  });
}

test('of two processes copying to one name with COPY_EXCL, exactly one succeeds and the other gets EEXIST (#1017)', {
  timeout: 120_000,
}, async (t) => {
  const bash = await kernelWith(t);
  const r = await bash(
    'mkdir -p /home/r && head -c 50000 /dev/urandom > /home/r/src && for i in $(seq 20); do copytest copy /home/r/src /home/r/d$i 644 1 > /home/r/a$i & copytest copy /home/r/src /home/r/d$i 644 1 > /home/r/b$i; wait; done; cat /home/r/a* /home/r/b*; for i in $(seq 20); do same /home/r/src /home/r/d$i || echo bad $i; done'
  );
  assert.equal(r.status, 0, r.stderr);
  const counts = {};
  for (const line of r.stdout.trim().split('\n')) {
    const key = line.replace(/d\d+/, 'dN');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  assert.deepEqual(counts, { 'copy /home/r/dN: ok': 20, 'copy /home/r/dN: File exists': 20 });
});

test('a copy costs one kernel call per file, and an exclusive copy writes through the handle its create made: under 5.5 OPFS requests, not 6.9 (#1017)', {
  timeout: 120_000,
}, async (t) => {
  const bash = await kernelWith(t);
  const r = await bash(
    'mkdir -p /home/n/s /home/n/d && cd /home/n/s && for i in $(seq 0 39); do head -c 3000 /dev/urandom > f$i; done && copytest many /home/n/s /home/n/d 40 && same /home/n/s/f7 /home/n/d/f7'
  );
  assert.equal(r.status, 0, r.stderr);
  const [calls, lookups, requests] = r.stdout
    .trim()
    .split(' ')
    .map((v) => Number(v) / 40);
  console.log(
    `per copied file: ${calls.toFixed(2)} kernel calls, ${lookups.toFixed(2)} OPFS lookups, ${requests.toFixed(2)} OPFS requests`
  );
  assert.ok(calls <= 1.5, `${calls} kernel calls per copy`);
  assert.ok(requests >= 1 && requests <= 5.5, `${requests} OPFS requests per copy`);
});

test('an imports module copies with ctx.fs.copyFile, with the same mode, exclusivity and errors (#1017)', {
  timeout: 60_000,
}, async (t) => {
  const bash = await kernelWith(t);
  assert.deepEqual(
    await bash(
      'mkdir -p /home/h && cd /home/h && head -c 9000 /dev/urandom > src && copyhost copy /home/h/src /home/h/a 755 1 && same src a && stat -c %a a && (umask 077; copyhost copy /home/h/src /home/h/b 666 1) && stat -c %a b && copyhost copy /home/h/src /home/h/a 644 1; copyhost copy /home/h/src /dev/shm/x 644 1; copyhost copy /home/h/none /home/h/c 644 1'
    ),
    ok(
      'copy /home/h/a: ok\n755\ncopy /home/h/b: ok\n600\ncopy /home/h/a: File exists\ncopy /dev/shm/x: Cross-device link\ncopy /home/h/c: No such file or directory\n'
    )
  );
});
