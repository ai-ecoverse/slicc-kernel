import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { fakeCronClock } from '../../dist/testing.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const SPOOL = '/var/spool/cron/crontabs';

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

async function boot(t, options = {}) {
  const clock = fakeCronClock(Date.UTC(2026, 0, 1, 10, 0, 30));
  const kernel = await createNodeKernel({ users: 'enforce', cron: { clock }, ...options });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  await kernel.users.add({ name: 'cone' });
  await kernel.users.add({ name: 'scoop' });
  const as = (user, script, opts = {}) =>
    kernel.run(['bash', '-c', script], {
      user,
      cwd: user === 'root' ? '/root' : `/home/${user}`,
      ...opts,
    });
  return { kernel, clock, as };
}

const result = ({ status, stdout, stderr }) => ({ status, stdout, stderr });

test("crontab installs from stdin or a file, lists and removes the caller's own table, and the table runs", async (t) => {
  const { kernel, clock, as } = await boot(t);
  assert.deepEqual(result(await as('cone', 'crontab -l')), {
    status: 1,
    stdout: '',
    stderr: 'no crontab for cone\n',
  });
  const table = '# name: hi\n* * * * * echo hi >> hi\n';
  assert.deepEqual(result(await as('cone', 'crontab -', { stdin: table })), {
    status: 0,
    stdout: '',
    stderr: '',
  });
  assert.deepEqual(result(await as('cone', 'crontab -l')), {
    status: 0,
    stdout: table,
    stderr: '',
  });
  assert.equal((await as('root', `stat -c '%U %a' ${SPOOL}/cone`)).stdout, 'cone 600\n');
  await delay(150);
  await clock.flush();
  clock.advance(60_000);
  let ran;
  for (let i = 0; i < 100 && !ran; i++) {
    await delay(50);
    ran = await kernel.readFile('/home/cone/hi').then(
      (b) => new TextDecoder().decode(b),
      () => undefined
    );
  }
  assert.equal(ran, 'hi\n');
  await as('cone', 'printf "@daily echo d\\n" > mine');
  assert.equal((await as('cone', 'crontab mine && crontab -l')).stdout, '@daily echo d\n');
  assert.deepEqual(result(await as('cone', 'crontab -r; crontab -l')), {
    status: 1,
    stdout: '',
    stderr: 'no crontab for cone\n',
  });
  assert.deepEqual(result(await as('cone', 'crontab -r')), {
    status: 1,
    stdout: '',
    stderr: 'no crontab for cone\n',
  });
});

test("crontab -u is root's, and a user can reach no other user's table or /etc/crontab", async (t) => {
  const { as } = await boot(t);
  await as('scoop', 'crontab -', { stdin: '@daily echo scoop\n' });
  assert.deepEqual(result(await as('cone', 'crontab -u scoop -l')), {
    status: 1,
    stdout: '',
    stderr: 'crontab: must be privileged to use -u\n',
  });
  assert.equal((await as('cone', 'crontab -u scoop -r')).status, 1);
  assert.equal((await as('cone', 'crontab -u cone -l')).stderr, 'no crontab for cone\n');
  assert.deepEqual(result(await as('root', 'crontab -u scoop -l')), {
    status: 0,
    stdout: '@daily echo scoop\n',
    stderr: '',
  });
  assert.equal((await as('root', 'crontab -u ghost -l')).stderr, 'crontab: user ghost unknown\n');
  assert.equal(
    (
      await as(
        'root',
        'echo "@daily echo c" | crontab -u cone - && stat -c %U /var/spool/cron/crontabs/cone'
      )
    ).stdout,
    'cone\n'
  );
  for (const script of [
    `cat ${SPOOL}/scoop`,
    `ls ${SPOOL}`,
    `echo "* * * * * echo x" > ${SPOOL}/scoop`,
    `echo "* * * * * echo x" > ${SPOOL}/cone`,
    `rm ${SPOOL}/scoop`,
    'echo "* * * * * root echo x" >> /etc/crontab',
  ]) {
    assert.notEqual((await as('cone', script)).status, 0, script);
  }
  assert.equal((await as('root', 'crontab -u scoop -l')).stdout, '@daily echo scoop\n');
  assert.equal(
    (await as('root', 'crontab -l; echo "@reboot echo r" | crontab - && crontab -l')).stdout,
    '@reboot echo r\n'
  );
});

test('crontab refuses a bad table and keeps the old one, and reports what it cannot read', async (t) => {
  const { as } = await boot(t);
  await as('cone', 'crontab -', { stdin: '@daily echo ok\n' });
  assert.deepEqual(
    result(
      await as('cone', 'crontab -', { stdin: '@daily echo ok\n61 * * * * echo bad\n* * *\n' })
    ),
    {
      status: 1,
      stdout: '',
      stderr:
        'crontab: errors in crontab file, cannot install\n"-":2: minute: 61 is outside 0-59\n"-":3: no command\n',
    }
  );
  assert.equal((await as('cone', 'crontab -l')).stdout, '@daily echo ok\n');
  assert.deepEqual(result(await as('cone', 'crontab /etc/sudoers')), {
    status: 1,
    stdout: '',
    stderr: 'crontab: /etc/sudoers: EACCES\n',
  });
  assert.equal((await as('cone', 'crontab missing')).stderr, 'crontab: missing: ENOENT\n');
  for (const args of ['', '-l -r', '-u', '-x', 'a b', '-l file']) {
    assert.deepEqual(
      result(await as('cone', `crontab ${args}`)),
      {
        status: 1,
        stdout: '',
        stderr: 'usage: crontab [-u user] { -l | -r | -e | file | - }\n',
      },
      args
    );
  }
});

test('crontab -e edits a copy with $VISUAL or $EDITOR and installs it', async (t) => {
  const { as } = await boot(t);
  const editor = (line) => `add() { echo "${line}" >> "$1"; }; add`;
  assert.equal(
    (await as('cone', 'crontab -e', { env: { EDITOR: editor('@daily echo one') } })).status,
    0
  );
  assert.equal((await as('cone', 'crontab -l')).stdout, '@daily echo one\n');
  assert.equal(
    (
      await as('cone', 'crontab -e', {
        env: { EDITOR: 'false', VISUAL: editor('@hourly echo two') },
      })
    ).status,
    0
  );
  assert.equal((await as('cone', 'crontab -l')).stdout, '@daily echo one\n@hourly echo two\n');
  assert.deepEqual(result(await as('cone', 'crontab -e', { env: { EDITOR: 'true' } })), {
    status: 0,
    stdout: '',
    stderr: 'crontab: no changes made to crontab\n',
  });
  assert.deepEqual(result(await as('cone', 'crontab -e', { env: { EDITOR: 'false' } })), {
    status: 1,
    stdout: '',
    stderr: 'crontab: the editor exited with status 1, crontab not changed\n',
  });
  const bad = await as('cone', 'crontab -e', { env: { EDITOR: editor('61 * * * * echo bad') } });
  assert.equal(bad.status, 1);
  assert.match(
    bad.stderr,
    /^crontab: errors in crontab file, cannot install\n"-":3: minute: 61 is outside 0-59\ncrontab: your edit is kept in \/tmp\/crontab\.\d+\.[0-9a-f-]{36}\n$/
  );
  assert.equal((await as('cone', 'crontab -l')).stdout, '@daily echo one\n@hourly echo two\n');
  assert.deepEqual(result(await as('cone', 'crontab -e', { env: { EDITOR: '' } })), {
    status: 1,
    stdout: '',
    stderr: 'crontab: set VISUAL or EDITOR to edit, or install a file with crontab <file>\n',
  });
  assert.equal(
    (await as('scoop', 'crontab -e', { env: { EDITOR: editor('@daily echo s') } })).status,
    0
  );
  assert.equal((await as('scoop', 'crontab -l')).stdout, '@daily echo s\n');
});

test('crontab is a kernel command in /usr/bin that a package cannot replace', async (t) => {
  const { as } = await boot(t);
  assert.equal((await as('cone', 'command -v crontab')).stdout, '/usr/bin/crontab\n');
  assert.equal((await as('cone', 'ls /usr/bin/crontab')).stdout, '/usr/bin/crontab\n');
});

test('crontab works the same with users off, and -u still needs root', async (t) => {
  const { as } = await boot(t, { users: 'off' });
  assert.equal((await as('cone', 'crontab -', { stdin: '@daily echo off\n' })).status, 0);
  assert.equal((await as('cone', 'crontab -l')).stdout, '@daily echo off\n');
  assert.equal(
    (await as('cone', 'crontab -u scoop -l')).stderr,
    'crontab: must be privileged to use -u\n'
  );
  assert.equal((await as('root', 'crontab -u cone -l')).stdout, '@daily echo off\n');
});

test('a user whose name ends in .new has a table of their own that runs', async (t) => {
  const { kernel, clock, as } = await boot(t);
  await kernel.users.add({ name: 'cone.new' });
  assert.equal(
    (await as('cone', 'crontab -', { stdin: '* * * * * echo cone >> who\n' })).status,
    0
  );
  assert.equal(
    (await as('cone.new', 'crontab -', { stdin: '* * * * * echo new >> who\n' })).status,
    0
  );
  assert.equal((await as('cone', 'crontab -l')).stdout, '* * * * * echo cone >> who\n');
  assert.equal((await as('cone.new', 'crontab -l')).stdout, '* * * * * echo new >> who\n');
  assert.equal(
    (await as('root', 'ls -a /var/spool/cron/crontabs')).stdout,
    '.\n..\ncone\ncone.new\n'
  );
  await delay(150);
  await clock.flush();
  clock.advance(60_000);
  const read = (path) =>
    kernel.readFile(path).then(
      (b) => new TextDecoder().decode(b),
      () => undefined
    );
  let both;
  for (let i = 0; i < 100 && !both; i++) {
    await delay(50);
    const [a, b] = [await read('/home/cone/who'), await read('/home/cone.new/who')];
    if (a && b) both = [a, b];
  }
  assert.deepEqual(both, ['cone\n', 'new\n']);
});
