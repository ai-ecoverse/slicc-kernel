import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = fileURLToPath(new URL('../../node_modules/@ai-ecoverse/', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function install(kernel, base, dest) {
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(`${dest}/${relative(base, file)}`, await readFile(file));
  }
}

const SERVER = `import socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
s.listen(8)
for _ in range(int(sys.argv[2])):
    c, _ = s.accept()
    c.sendall(c.recv(64).upper())
    c.close()
`;

const CLIENT = `import socket, sys
s = socket.socket(socket.AF_UNIX)
try:
    s.connect(sys.argv[1])
    s.sendall(b'py')
    print('reply', s.recv(64).decode())
except OSError as e:
    print('connect:', e.strerror)
`;

const LISTENER = `import os, socket, sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
s.listen(1)
s.close()
os.unlink(sys.argv[1])
print('unlinked', os.path.exists(sys.argv[1]))
`;

const STAT = `import os, stat, sys
st = os.stat(sys.argv[1])
print('socket' if stat.S_ISSOCK(st.st_mode) else 'not a socket')
`;

async function booted(t, users = 'enforce') {
  const kernel = await createNodeKernel({ users });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) {
    await install(kernel, join(modules, name), `/node_modules/@ai-ecoverse/${name}`);
  }
  await install(kernel, join(fixtures, 'socktest'), '/node_modules/socktest');
  await kernel.writeFile('/opt/sock/server.py', SERVER);
  await kernel.writeFile('/opt/sock/client.py', CLIENT);
  await kernel.writeFile('/opt/sock/stat.py', STAT);
  await kernel.writeFile('/opt/sock/listener.py', LISTENER);
  if (users !== 'off') await kernel.users.add({ name: 'cone' });
  const bash = (script, user) => kernel.run(['bash', '-c', script], { cwd: '/', user });
  const serve = async (path, count, user, umask = '022') => {
    const done = bash(`umask ${umask}; python3 /opt/sock/server.py ${path} ${count}`, user);
    const wait = `for i in $(seq 200); do [ -S ${path} ] && exit 0; sleep 0.05; done; exit 1`;
    assert.equal((await bash(wait)).status, 0, `${path} never appeared`);
    return { done };
  };
  const connect = (path, user) =>
    bash(`python3 /opt/sock/client.py ${path}; socktest unixclient ${path} em`, user);
  return { bash, serve, connect };
}

const replies = { status: 0, stdout: 'reply PY\nreply EM\n', stderr: '' };
const refused = (why) => ({ status: 1, stdout: `connect: ${why}\nconnect: ${why}\n`, stderr: '' });

test('under enforce, a user cannot connect to a socket in a directory it cannot search; the owner and root can (#753)', async (t) => {
  const { bash, serve, connect } = await booted(t);
  await bash('mkdir -m 700 /root/agent');
  const server = await serve('/root/agent/S.sock', 2);
  assert.deepEqual(await connect('/root/agent/S.sock', 'cone'), refused('Permission denied'));
  assert.deepEqual(await connect('/root/agent/S.sock'), replies);
  assert.equal((await server.done).status, 0);
});

test('under enforce, connect needs write permission on the socket itself (#753)', async (t) => {
  const { bash, serve, connect } = await booted(t);
  const server = await serve('/tmp/root.sock', 2);
  assert.deepEqual(await connect('/tmp/root.sock', 'cone'), refused('Permission denied'));
  assert.deepEqual(await bash('chmod 666 /tmp/root.sock'), { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(await connect('/tmp/root.sock', 'cone'), replies);
  const own = await serve('/tmp/cone.sock', 4, 'cone', '077');
  assert.deepEqual(await connect('/tmp/cone.sock', 'cone'), replies);
  assert.deepEqual(await connect('/tmp/cone.sock'), replies);
  assert.equal((await server.done).status, 0);
  assert.equal((await own.done).status, 0);
});

test('a bound socket is a socket node: stat, ls and test -S see it with the owner and the umask mode (#753)', async (t) => {
  const { bash, serve, connect } = await booted(t);
  const server = await serve('/tmp/cone.sock', 1, 'cone', '027');
  const shown = await bash(
    'stat -c "%F %a %U:%G" /tmp/cone.sock; ls -l /tmp/cone.sock | cut -c1; python3 /opt/sock/stat.py /tmp/cone.sock; cat /tmp/cone.sock'
  );
  assert.deepEqual(shown, {
    status: 1,
    stdout: 'socket 750 cone:cone\ns\nsocket\n',
    stderr: 'cat: /tmp/cone.sock: No such device or address\n',
  });
  assert.deepEqual(await connect('/tmp/cone.sock', 'cone'), {
    status: 1,
    stdout: 'reply PY\nconnect: Connection refused\n',
    stderr: '',
  });
  assert.equal((await server.done).status, 0);
});

test('unlink removes the name; a stale name refuses and blocks a new bind until it is removed (#753)', async (t) => {
  const { bash, serve, connect } = await booted(t);
  const first = await serve('/tmp/s.sock', 1);
  first.done.catch(() => undefined);
  assert.deepEqual(await bash('rm /tmp/s.sock && ls /tmp'), { status: 0, stdout: '', stderr: '' });
  assert.deepEqual(await connect('/tmp/s.sock'), refused('No such file or directory'));
  const second = await serve('/tmp/s.sock', 2);
  assert.deepEqual(await connect('/tmp/s.sock'), replies);
  assert.equal((await second.done).status, 0);
  assert.deepEqual(await connect('/tmp/s.sock'), refused('Connection refused'));
  const again = await bash('python3 /opt/sock/server.py /tmp/s.sock 1');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /OSError: \[Errno \d+\] Address (already )?in use/);
  assert.equal((await bash('rm /tmp/s.sock; [ -e /tmp/s.sock ]')).status, 1);
  const third = await serve('/tmp/s.sock', 1);
  assert.deepEqual(await bash('python3 /opt/sock/client.py /tmp/s.sock'), {
    status: 0,
    stdout: 'reply PY\n',
    stderr: '',
  });
  assert.equal((await third.done).status, 0);
});

test('without users, a socket is still a node that connect finds by name (#753)', async (t) => {
  const { bash, serve, connect } = await booted(t, 'off');
  const server = await serve('/tmp/plain.sock', 2);
  assert.deepEqual(await bash('stat -c %F /tmp/plain.sock'), {
    status: 0,
    stdout: 'socket\n',
    stderr: '',
  });
  assert.deepEqual(await connect('/tmp/plain.sock'), replies);
  assert.equal((await server.done).status, 0);
  assert.deepEqual(await connect('/tmp/missing.sock'), refused('No such file or directory'));
});

test('the process that bound a socket unlinks its name at exit, as multiprocessing does (#753)', async (t) => {
  const { bash } = await booted(t);
  assert.deepEqual(await bash('python3 /opt/sock/listener.py /tmp/m.sock', 'cone'), {
    status: 0,
    stdout: 'unlinked False\n',
    stderr: '',
  });
});

test('a renamed socket answers at its new name (#753)', async (t) => {
  const { bash, serve, connect } = await booted(t);
  const server = await serve('/tmp/old.sock', 2);
  assert.deepEqual(await bash('mv /tmp/old.sock /tmp/new.sock'), {
    status: 0,
    stdout: '',
    stderr: '',
  });
  assert.deepEqual(await connect('/tmp/old.sock'), refused('No such file or directory'));
  assert.deepEqual(await connect('/tmp/new.sock'), replies);
  assert.equal((await server.done).status, 0);
});
