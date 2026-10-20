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

test('a program started with an empty environment gets no HOSTNAME, yet uname -n, hostname, /etc/hostname and a WASIX gethostname still give the kernel name, and a shell still has $HOSTNAME (#1272)', async (t) => {
  const kernel = await createNodeKernel({ hostname: 'devbox' });
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
  const r = await kernel.run(
    [
      'bash',
      '-c',
      [
        'case "$(env -i env)" in *HOSTNAME=*) echo has ;; *) echo none ;; esac',
        'env -i uname -n',
        'env -i hostname',
        'env -i cat /etc/hostname',
        'env -i python3 -c "import socket; print(socket.gethostname())"',
        'echo "shell $HOSTNAME"',
      ].join('; '),
    ],
    { cwd: '/' }
  );
  assert.equal(r.stdout, 'none\ndevbox\ndevbox\ndevbox\ndevbox\nshell devbox\n', r.stderr);
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

test('an exclusive create of the synthetic /etc/hostname is EEXIST, a dangling symlink there stays dangling, and root writing it from a shell or a WASI program makes the real file (#1301 review)', async (t) => {
  const kernel = await createNodeKernel({ hostname: 'devbox' });
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
  const probe = `python3 -c "
import os, errno
try:
    os.close(os.open('/etc/hostname', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644))
    print('created')
except OSError as e:
    print(errno.errorcode[e.errno])
print(open('/etc/hostname').read().strip())
"`;
  const excl = await kernel.run(['bash', '-c', probe], { cwd: '/' });
  assert.equal(excl.stdout, 'EEXIST\ndevbox\n', excl.stderr);
  const dangling = await kernel.run(
    [
      'python3',
      '-c',
      "import os; os.symlink('/nowhere', '/etc/hostname'); print(os.path.exists('/etc/hostname'), os.path.islink('/etc/hostname'))",
    ],
    { cwd: '/' }
  );
  assert.equal(dangling.stdout, 'False True\n', dangling.stderr);
  await kernel.run(['python3', '-c', "import os; os.unlink('/etc/hostname')"], { cwd: '/' });
  const shell = await kernel.run(
    ['bash', '-c', 'echo other > /etc/hostname && cat /etc/hostname'],
    { cwd: '/' }
  );
  assert.equal(shell.stdout, 'other\n', shell.stderr);
  const wasi = await kernel.run(
    [
      'python3',
      '-c',
      "import os; os.unlink('/etc/hostname'); open('/etc/hostname', 'w').write('third\\n'); print(open('/etc/hostname').read().strip())",
    ],
    { cwd: '/' }
  );
  assert.equal(wasi.stdout, 'third\n', wasi.stderr);
});
