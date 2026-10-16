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

async function boot(t, more = []) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', ...more]) await install(kernel, name);
  await kernel.users.add({ name: 'cone' });
  const sh = (script, user) =>
    kernel.run(['bash', '-c', script], { cwd: '/', ...(user ? { user } : {}) });
  return { sh };
}

const DEFAULTS = ['127.0.0.1 localhost localhost.localdomain', '::1 localhost ip6-localhost'];

test('appending to /etc/hosts as root keeps its default entries and makes it a real root 644 file; rm brings the defaults back (#895)', async (t) => {
  const { sh } = await boot(t);
  const before = await sh('cat /etc/hosts');
  assert.equal(before.status, 0);
  const lines = before.stdout.split('\n').filter(Boolean);
  assert.deepEqual(lines.slice(0, 2), DEFAULTS);
  assert.equal(lines.length, 4);
  assert.deepEqual(
    await sh(
      "echo '127.0.0.9 extra' >> /etc/hosts && cat /etc/hosts && stat -c '%F %U %G %a' /etc/hosts"
    ),
    {
      status: 0,
      stdout: `${before.stdout}127.0.0.9 extra\nregular file root root 644\n`,
      stderr: '',
    }
  );
  assert.deepEqual(await sh('echo again >> /etc/hosts && tail -n 2 /etc/hosts'), {
    status: 0,
    stdout: '127.0.0.9 extra\nagain\n',
    stderr: '',
  });
  assert.deepEqual(await sh('rm /etc/hosts && cat /etc/hosts'), {
    status: 0,
    stdout: before.stdout,
    stderr: '',
  });
});

test('> /etc/hosts replaces the defaults as on Linux, and a user who may not write it changes nothing (#895)', async (t) => {
  const { sh } = await boot(t);
  const before = (await sh('cat /etc/hosts')).stdout;
  const denied = await sh('echo x >> /etc/hosts', 'cone');
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /Permission denied/);
  assert.equal((await sh('cat /etc/hosts')).stdout, before);
  assert.notEqual((await sh('stat /etc/hosts')).status, 0);
  assert.deepEqual(await sh('echo "10.0.0.1 only" > /etc/hosts && cat /etc/hosts'), {
    status: 0,
    stdout: '10.0.0.1 only\n',
    stderr: '',
  });
});

const lookup = (name) =>
  `python3 -c "import socket\ntry: print(socket.gethostbyname('${name}'))\nexcept OSError as e: print('no', e.errno)"`;

test('under umask 077 the seeded /etc/hosts is still 0644, so a user reads it, and a program that reads it resolves localhost and an added name (#895)', async (t) => {
  const { sh } = await boot(t, ['wasix-python']);
  assert.deepEqual(
    await sh("umask 077 && echo '10.0.0.9 zzydb' >> /etc/hosts && stat -c '%a %U %G' /etc/hosts"),
    { status: 0, stdout: '644 root root\n', stderr: '' }
  );
  assert.deepEqual(
    await sh(`head -n 1 /etc/hosts && ${lookup('localhost')} && ${lookup('zzydb')}`, 'cone'),
    {
      status: 0,
      stdout: '127.0.0.1 localhost localhost.localdomain\n127.0.0.1\n10.0.0.9\n',
      stderr: '',
    }
  );
});
