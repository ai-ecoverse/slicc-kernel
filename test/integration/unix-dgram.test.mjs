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
  await kernel.users.add({ name: 'cone' });
  const py = async (code, user) => {
    await kernel.writeFile('/opt/t.py', code);
    await kernel.run(['chmod', '644', '/opt/t.py'], { cwd: '/' });
    return kernel.run(['python3', '/opt/t.py'], { cwd: '/', ...(user ? { user } : {}) });
  };
  const sh = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  return { kernel, py, sh };
}

const PRELUDE = `import errno, os, socket
def dgram():
    return socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
def err(e):
    return errno.errorcode.get(e.errno, str(e.errno))
`;

test('AF_UNIX SOCK_DGRAM: bind to paths, sendto and recvfrom with the sender path, one message per send, truncation (#891)', async (t) => {
  const { py, sh } = await booted(t);
  const got = await py(`${PRELUDE}
a = dgram(); b = dgram()
a.bind('/tmp/a.sock'); b.bind('/tmp/b.sock')
a.sendto(b'one', '/tmp/b.sock'); a.sendto(b'two!', '/tmp/b.sock')
print(b.recvfrom(64)); print(b.recvfrom(2))
c = dgram()
c.sendto(b'anon', '/tmp/b.sock'); print(b.recvfrom(64))
b.sendto(b'back', '/tmp/a.sock'); print(a.recvfrom(64))
print(a.getsockname(), b.getsockname(), b.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_DGRAM)
`);
  assert.deepEqual(got, {
    status: 0,
    stdout:
      "(b'one', '/tmp/a.sock')\n(b'tw', '/tmp/a.sock')\n(b'anon', '')\n(b'back', '/tmp/b.sock')\n/tmp/a.sock /tmp/b.sock True\n",
    stderr: '',
  });
  assert.equal((await sh("stat -c '%F' /tmp/a.sock")).stdout, 'socket\n');
});

test('AF_UNIX SOCK_DGRAM socketpair and connect keep message boundaries, and a full queue is EAGAIN without blocking (#891)', async (t) => {
  const { py } = await booted(t);
  const got = await py(`${PRELUDE}
p, q = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)
p.send(b'x1'); p.send(b'x22'); q.send(b'y')
print(q.recv(64), q.recv(64), p.recv(64))
b = dgram(); b.bind('/tmp/b.sock')
c = dgram(); c.connect('/tmp/b.sock'); c.send(b'conn')
print(b.recvfrom(64), c.getpeername())
c.setblocking(False)
n = 0
try:
    while True:
        c.send(b'z' * 1024); n += 1
except OSError as e:
    print('full', err(e), n > 0)
`);
  assert.deepEqual(got, {
    status: 0,
    stdout: "b'x1' b'x22' b'y'\n(b'conn', '') /tmp/b.sock\nfull EAGAIN True\n",
    stderr: '',
  });
});

test('AF_UNIX SOCK_DGRAM errors: a missing path, a file nobody bound, a stream socket, a taken path (#891)', async (t) => {
  const { py } = await booted(t);
  const got = await py(`${PRELUDE}
open('/tmp/plain', 'w').close()
s = socket.socket(socket.AF_UNIX); s.bind('/tmp/s.sock'); s.listen(1)
d = dgram(); d.bind('/tmp/d.sock')
c = dgram()
for path in ['/tmp/none.sock', '/tmp/plain', '/tmp/s.sock']:
    try:
        c.sendto(b'x', path)
    except OSError as e:
        print(path, err(e))
try:
    dgram().bind('/tmp/d.sock')
except OSError as e:
    print('bind', err(e))
try:
    socket.socket(socket.AF_UNIX).connect('/tmp/d.sock')
except OSError as e:
    print('stream connect', err(e))
`);
  assert.deepEqual(got, {
    status: 0,
    stdout:
      '/tmp/none.sock ENOENT\n/tmp/plain ECONNREFUSED\n/tmp/s.sock EPROTOTYPE\nbind EADDRINUSE\nstream connect EPROTOTYPE\n',
    stderr: '',
  });
});

test('AF_UNIX SOCK_DGRAM under enforce: sending needs write on the socket file, binding needs write on its directory (#891)', async (t) => {
  const { py, sh } = await booted(t);
  await sh('mkdir -p /srv/log && chmod 755 /srv/log');
  const root = await py(`${PRELUDE}
d = dgram(); d.bind('/srv/log/dev.sock'); os.chmod('/srv/log/dev.sock', 0o600)
print('bound')
`);
  assert.equal(root.status, 0);
  const user = await py(
    `${PRELUDE}
try:
    dgram().sendto(b'x', '/srv/log/dev.sock')
except OSError as e:
    print('send', err(e))
try:
    dgram().connect('/srv/log/dev.sock')
except OSError as e:
    print('connect', err(e))
try:
    dgram().bind('/srv/log/mine.sock')
except OSError as e:
    print('bind', err(e))
`,
    'cone'
  );
  assert.deepEqual(user, {
    status: 0,
    stdout: 'send EACCES\nconnect EACCES\nbind EACCES\n',
    stderr: '',
  });
});

test('AF_UNIX SOCK_DGRAM under enforce: a user can neither connect to nor send to a live root receiver it may not write, and the receiver gets nothing (#891)', async (t) => {
  const { kernel, sh } = await booted(t);
  await sh('mkdir -p /srv/log && chmod 755 /srv/log && rm -f /tmp/ready /tmp/go');
  await kernel.writeFile(
    '/opt/root.py',
    `${PRELUDE}
import time
d = dgram(); d.bind('/srv/log/dev.sock'); os.chmod('/srv/log/dev.sock', 0o600)
open('/tmp/ready', 'w').close()
while not os.path.exists('/tmp/go'):
    time.sleep(0.05)
d.settimeout(0.5)
try:
    print('got', d.recvfrom(64))
except OSError as e:
    print('nothing', type(e).__name__)
dgram().sendto(b'self', '/srv/log/dev.sock')
print('live', d.recvfrom(64)[0])
`
  );
  await kernel.writeFile(
    '/opt/cone.py',
    `${PRELUDE}
import time
while not os.path.exists('/tmp/ready'):
    time.sleep(0.05)
c = dgram()
try:
    c.connect('/srv/log/dev.sock')
except OSError as e:
    print('connect', err(e))
try:
    c.send(b'after')
except OSError as e:
    print('unconnected', err(e))
try:
    dgram().sendto(b'sneak', '/srv/log/dev.sock')
except OSError as e:
    print('send', err(e))
open('/tmp/go', 'w').close()
`
  );
  await sh('chmod 644 /opt/root.py /opt/cone.py && chmod 1777 /tmp');
  const root = kernel.run(['python3', '/opt/root.py'], { cwd: '/' });
  const cone = await kernel.run(['python3', '/opt/cone.py'], { cwd: '/', user: 'cone' });
  assert.deepEqual(cone, {
    status: 0,
    stdout: 'connect EACCES\nunconnected EDESTADDRREQ\nsend EACCES\n',
    stderr: '',
  });
  assert.deepEqual(await root, {
    status: 0,
    stdout: "nothing TimeoutError\nlive b'self'\n",
    stderr: '',
  });
});
