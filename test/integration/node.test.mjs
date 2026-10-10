import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, nodeTransport } from '../../dist/node.js';

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

test('a headless kernel in Node runs bash and coreutils on an in-memory root', async () => {
  const kernel = await createNodeKernel({ env: { GREETING: 'hello' } });
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  await kernel.writeFile('/home/in.txt', 'b\na\nc\n');

  const sorted = await kernel.run(
    ['bash', '-c', 'sort /home/in.txt | tr "\\n" " "; echo "$GREETING" > /home/out.txt'],
    {
      cwd: '/home',
    }
  );
  assert.deepEqual(sorted, { status: 0, stdout: 'a b c ', stderr: '' });
  assert.equal(new TextDecoder().decode(await kernel.readFile('/home/out.txt')), 'hello\n');
  assert.deepEqual(
    await kernel.run(['bash', '-c', 'read x; echo "got $x"'], { stdin: 'piped\n' }),
    {
      status: 0,
      stdout: 'got piped\n',
      stderr: '',
    }
  );

  const screen = [];
  const term = await kernel.openTerminal(
    ['bash', '-c', 'echo "tty $(tty -s && echo yes)"; exit 4'],
    { cwd: '/home' }
  );
  term.onData = (bytes) => screen.push(new TextDecoder().decode(bytes));
  assert.equal(await term.exited, 4);
  assert.match(screen.join(''), /tty yes/);

  kernel.terminate();
  await assert.rejects(kernel.run(['bash', '-c', 'true']), /terminated/);
});

test('nodeTransport reaches the registry through the realm proxy, without CORS', async () => {
  const kernel = await createNodeKernel({ network: { transport: nodeTransport() } });
  for (const name of ['wasm-bash', 'wasm-curl', 'wasm-tls-engine']) await install(kernel, name);
  const r = await kernel.run([
    'bash',
    '-c',
    'curl -sS https://registry.npmjs.org/@ai-ecoverse/wasm-bash/latest',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"name":"@ai-ecoverse\/wasm-bash"/);
  kernel.terminate();
});

test('a worker thread attaches to a Node kernel, spawns, and sees its process in the shared table', async () => {
  const { Worker } = await import('node:worker_threads');
  const kernel = await createNodeKernel();
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  const port = await kernel.connect();
  const dist = new URL('../../dist/node.js', import.meta.url).href;
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.dist).then(async ({ attachKernel }) => {
        const client = await attachKernel(workerData.port);
        const child = await client.spawn(['sleep', '100']);
        parentPort.postMessage({ pid: child.pid });
        parentPort.postMessage({ status: await child.exited });
        await client.close();
      });
    `,
    { eval: true, workerData: { port, dist }, transferList: [port] }
  );
  const messages = [];
  const next = () =>
    new Promise((resolve) => worker.once('message', (m) => resolve(messages.push(m) && m)));
  const { pid } = await next();
  const seen = await kernel.run(['bash', '-c', `cat /proc/${pid}/comm`]);
  assert.deepEqual(seen, { status: 0, stdout: 'sleep\n', stderr: '' });
  const exited = next();
  assert.deepEqual(await kernel.run(['bash', '-c', `kill ${pid}`]), {
    status: 0,
    stdout: '',
    stderr: '',
  });
  assert.deepEqual(await exited, { status: 143 });
  await worker.terminate();
  kernel.terminate();
});

async function installDir(kernel, dir, at) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(`${at}/${relative(dir, file)}`, await readFile(file));
  }
}

function objectStore() {
  const objects = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://store');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\/?/, ''));
    if (req.method === 'GET' && url.searchParams.has('list')) {
      const prefix = url.searchParams.get('list');
      const listed = [...objects]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, o]) => ({ key: k, size: o.body.length, mtime: o.mtime }));
      res.end(JSON.stringify(listed));
    } else if (req.method === 'PUT') {
      objects.set(key, { body: Buffer.concat(chunks), mtime: Date.now() });
      res.end();
    } else if (!objects.has(key)) {
      res.statusCode = 404;
      res.end();
    } else if (req.method === 'DELETE') {
      objects.delete(key);
      res.end();
    } else res.end(objects.get(key).body);
  });
  return { objects, server };
}

const SCRIPT = [
  'git config --global user.name kernel && git config --global user.email kernel@example.com',
  'cd /mnt/s3 && echo one > a.txt && echo two >> a.txt && printf three > b.txt && echo over > b.txt',
  'mv b.txt c.txt && mkdir -p d/e && rmdir d/e && echo gone > g.txt && rm g.txt',
  'git init -q && git add . && git commit -qm first && git log --format=%s && git status --porcelain',
  'echo moved > m.txt && mv m.txt /home/m.txt && cat /home/m.txt && ls /mnt/s3',
].join(' && ');

test('a package driver mounts a mock S3; programs and git work on it, unmounting leaves it in the store, and a remount shows it all again', async (t) => {
  const { objects, server } = objectStore();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/bucket`;
  const kernel = await createNodeKernel({ network: { transport: nodeTransport() } });
  t.after(() => {
    kernel.terminate();
    server.close();
  });
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-git']) await install(kernel, name);
  await installDir(
    kernel,
    fileURLToPath(new URL('./fixtures/mock-s3/', import.meta.url)),
    '/node_modules/mock-s3'
  );
  await kernel.run(['bash', '-c', 'mkdir -p /mnt/s3']);
  const mounted = await kernel.mount({ type: 'mocks3', source: endpoint, target: '/mnt/s3' });
  assert.equal(mounted.state, 'ok');
  const r = await kernel.run(['bash', '-c', SCRIPT]);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, 'first\nmoved\nINDEX\n'.replace('INDEX\n', 'a.txt\nc.txt\nd\n'));
  await kernel.umount('/mnt/s3');
  const text = (k) => objects.get(k)?.body.toString();
  assert.deepEqual(
    [text('a.txt'), text('c.txt'), text('g.txt'), text('m.txt')],
    ['one\ntwo\n', 'over\n', undefined, undefined]
  );
  assert.ok([...objects.keys()].some((k) => k.startsWith('.git/objects/')));
  await kernel.mount({ type: 'mocks3', source: endpoint, target: '/mnt/s3' });
  const again = await kernel.run([
    'bash',
    '-c',
    'cd /mnt/s3 && cat a.txt c.txt && ls -l a.txt | cut -d" " -f5 && git log --format=%s && git status --porcelain && echo clean',
  ]);
  assert.deepEqual(again, { status: 0, stdout: 'one\ntwo\nover\n8\nfirst\nclean\n', stderr: '' });
  await kernel.umount('/mnt/s3');
});

test('a command pnpm installs globally runs in the same shell, and is gone once removed', async (t) => {
  const kernel = await createNodeKernel({
    network: { transport: nodeTransport() },
  });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-tls-engine', 'wasi-pnpm']) {
    await install(kernel, name);
  }
  const term = await kernel.openTerminal(['bash', '-i'], { cwd: '/home' });
  let screen = '';
  term.onData = (bytes) => {
    screen += new TextDecoder().decode(bytes);
  };
  const until = async (text) => {
    for (let i = 0; i < 1200 && !screen.includes(text); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(screen.includes(text), screen);
  };
  await until('$ ');
  term.write('echo "home $PNPM_HOME"; rg --version 2>/dev/null; echo "before $((100+27))"\r');
  await until('before 127');
  assert.match(screen, /home \/usr\/local\/share\/pnpm/);
  term.write(
    'pnpm add -g @ai-ecoverse/wasi-ripgrep >/dev/null && rg --version | head -1 && echo "added $((40+2))"\r'
  );
  await until('added 42');
  assert.match(screen, /ripgrep 15\.2\.0/);
  term.write(
    'pnpm remove -g @ai-ecoverse/wasi-ripgrep >/dev/null; rg --version 2>/dev/null; echo "removed $?"\r'
  );
  await until('removed 127');
  term.close();
  assert.equal(await term.exited, 129);
});

test('a WASI process killed by SIGKILL keeps the bytes it wrote but never fsynced', async () => {
  const kernel = await createNodeKernel();
  for (const pkg of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, pkg);
  const program =
    "f=open('/home/f','wb'); f.write(b'x'*3145728); print('wrote',flush=True); import time; time.sleep(600)";
  const r = await kernel.run([
    'bash',
    '-c',
    `python3 -c "${program}" > /tmp/out & P=$!; until [ -s /tmp/out ]; do sleep 0.1; done; ` +
      'kill -KILL $P; wait $P; echo rc=$?',
  ]);
  assert.match(r.stdout, /^rc=137\n/);
  assert.equal((await kernel.readFile('/home/f')).length, 3145728);
  kernel.terminate();
});
