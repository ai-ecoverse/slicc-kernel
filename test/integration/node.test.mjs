import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, nodeTransport } from '../../dist/node.js';
import { hostfsProxy } from './hostfs-proxy.mjs';

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
  const transport = nodeTransport({ hostLoopback: [server.address().port] });
  const kernel = await createNodeKernel({ network: { transport } });
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
    const shows = () => (text instanceof RegExp ? text.test(screen) : screen.includes(text));
    for (let i = 0; i < 1200 && !shows(); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(shows(), screen);
  };
  await until(/[$#] /);
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

test('a cone runs pnpm add and pnpm add -g under users: enforce, with no denial for its lock files', async (t) => {
  const denials = [];
  const kernel = await createNodeKernel({ users: 'enforce', onDenial: (d) => denials.push(d) });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-tls-engine', 'wasi-pnpm']) {
    await install(kernel, name);
  }
  await kernel.users.add({ name: 'cone', groups: ['sudo'], homeMode: 0o710, umask: 0o077 });
  await kernel.writeFile('/srv/tool.tgz', await localPackage());
  const script = [
    'mkdir app && cd app && echo \'{"name":"a","version":"1.0.0"}\' > package.json',
    'pnpm add file:/srv/tool.tgz > /dev/null 2>&1; echo "add $?"',
    'stat -c "%U %a" /tmp/pnpm-store-operation-locks-1000',
    'pnpm add -g file:/srv/tool.tgz > /dev/null 2>&1; echo "global $?"',
  ].join('\n');
  const r = await kernel.run(['bash', '-c', script], { cwd: '/home/cone', user: 'cone' });
  assert.equal(r.stdout, 'add 0\ncone 700\nglobal 0\n', r.stderr);
  assert.deepEqual(
    denials.filter((d) => d.path.includes('.slicc-unlinked') || d.path.startsWith('/tmp/pnpm')),
    []
  );
});

async function localPackage() {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-pkg-'));
  await mkdir(join(dir, 'package', 'bin'), { recursive: true });
  const manifest = {
    name: 'k3-tool',
    version: '1.0.0',
    slicc: { abi: 'js', commands: { k3tool: { module: 'bin/tool.mjs' } } },
  };
  await writeFile(join(dir, 'package', 'package.json'), JSON.stringify(manifest));
  await writeFile(
    join(dir, 'package', 'bin', 'tool.mjs'),
    'export default async function main(ctx) { await ctx.write(1, "tool ran\\n"); return 0; }\n'
  );
  execFileSync('tar', ['czf', join(dir, 'k3-tool.tgz'), '-C', dir, 'package']);
  const bytes = await readFile(join(dir, 'k3-tool.tgz'));
  await rm(dir, { recursive: true, force: true });
  return bytes;
}

test('pnpm installs globally as root and as a user with users off, report and enforce', async (t) => {
  const tarball = await localPackage();
  for (const users of ['off', 'report', 'enforce']) {
    await t.test(users, async () => {
      const kernel = await createNodeKernel({ users, network: { transport: nodeTransport() } });
      try {
        for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-tls-engine', 'wasi-pnpm']) {
          await install(kernel, name);
        }
        await kernel.writeFile('/tmp/pk/k3-tool.tgz', tarball);
        await kernel.users.add({ name: 'cone' });
        const owned = users === 'off' ? '' : '; stat -c "%U" "$PNPM_HOME"';
        const script = `pnpm add -g /tmp/pk/k3-tool.tgz >/dev/null 2>&1; echo "rc=$?"; k3tool${owned}`;
        for (const [user, owner] of [
          [undefined, 'root'],
          ['cone', 'cone'],
        ]) {
          const r = await kernel.run(
            ['bash', '-c', script],
            user ? { user, cwd: '/home/cone' } : { cwd: '/root' }
          );
          const shown = users === 'off' ? '' : `${owner}\n`;
          assert.equal(r.stdout, `rc=0\ntool ran\n${shown}`, `${users} ${owner}: ${r.stderr}`);
        }
        if (users !== 'off') {
          const layout = await kernel.run(
            ['stat', '-c', '%n %a %U', '/node_modules', '/usr/local/share/pnpm'],
            { cwd: '/' }
          );
          assert.equal(layout.stdout, '/node_modules 755 root\n/usr/local/share/pnpm 755 root\n');
        }
      } finally {
        kernel.terminate();
      }
    });
  }
});

async function toolPackage(name, said, replaces) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-pkg-'));
  await mkdir(join(dir, 'package'), { recursive: true });
  const slicc = { abi: 'js', commands: { k5tool: { module: 'tool.mjs' } } };
  const manifest = { name, version: '1.0.0', slicc: replaces ? { ...slicc, replaces } : slicc };
  await writeFile(join(dir, 'package', 'package.json'), JSON.stringify(manifest));
  await writeFile(
    join(dir, 'package', 'tool.mjs'),
    `export default async function main(ctx) { await ctx.write(1, "${said}\\n"); return 0; }\n`
  );
  execFileSync('tar', ['czf', join(dir, 'p.tgz'), '-C', dir, 'package']);
  const bytes = await readFile(join(dir, 'p.tgz'));
  await rm(dir, { recursive: true, force: true });
  return bytes;
}

test('a package that names another in slicc.replaces wins their shared commands while installed', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-tls-engine', 'wasi-pnpm']) {
    await install(kernel, name);
  }
  await kernel.users.add({ name: 'cone' });
  await kernel.writeFile('/srv/plain.tgz', await toolPackage('k5-tool', 'plain'));
  await kernel.writeFile('/srv/heif.tgz', await toolPackage('k5-tool-heif', 'heif', ['k5-tool']));
  await kernel.writeFile('/srv/bad.tgz', await toolPackage('k5-tool-bad', 'bad', 'k5-tool'));
  const script = [
    'cd /tmp && mkdir app && cd app && echo \'{"name":"a","version":"1.0.0"}\' > package.json',
    'pnpm add /srv/plain.tgz /srv/heif.tgz /srv/bad.tgz > /dev/null 2>&1; echo "add $?"',
    'cp -rL node_modules/k5-tool node_modules/k5-tool-heif /node_modules/',
    'k5tool',
    'rm -r /node_modules/k5-tool-heif && cp -rL node_modules/k5-tool-bad /node_modules/ && k5tool',
    'pnpm add -g /srv/heif.tgz > /dev/null 2>&1; echo "global $?"; k5tool',
  ].join('\n');
  const local = await kernel.run(['bash', '-c', script], { cwd: '/' });
  assert.equal(local.stdout, 'add 0\nheif\nplain\nglobal 0\nplain\n', local.stderr);
  const user = [
    'pnpm add -g /srv/plain.tgz > /dev/null 2>&1; echo "plain $?"',
    'pnpm add -g /srv/heif.tgz > /dev/null 2>&1; echo "heif $?"',
    'k5tool',
    'pnpm remove -g k5-tool-heif > /dev/null 2>&1; echo "removed $?"',
    'k5tool',
  ].join('\n');
  const r = await kernel.run(['bash', '-c', user], { cwd: '/home/cone', user: 'cone' });
  assert.equal(r.stdout, 'plain 0\nheif 0\nheif\nremoved 0\nplain\n', r.stderr);
});

test('a user with a non-canonical home runs a command from its global packages', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.users.add({ name: 'cone', home: '/srv/../srv/cone/' });
  const pkg = '/srv/cone/.local/share/pnpm/global/5/g1/node_modules/k3-tool';
  await kernel.writeFile(
    `${pkg}/package.json`,
    JSON.stringify({
      name: 'k3-tool',
      version: '1.0.0',
      slicc: { abi: 'js', commands: { k3tool: { module: 'bin/tool.mjs' } } },
    })
  );
  await kernel.writeFile(
    `${pkg}/bin/tool.mjs`,
    'export default async function main(ctx) { await ctx.write(1, "tool ran\\n"); return 0; }\n'
  );
  const r = await kernel.run(['bash', '-c', 'k3tool; command -v k3tool'], {
    cwd: '/srv/cone',
    user: 'cone',
  });
  assert.equal(r.stdout, 'tool ran\n/srv/cone/.local/share/pnpm/bin/k3tool\n', r.stderr);
});

test('a new process finds PNPM_HOME after nested mounts over its ancestors', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.mount({ type: 'tmpfs', source: 'none', target: '/usr/local' });
  await kernel.mount({ type: 'tmpfs', source: 'none', target: '/usr' });
  await kernel.run(['true'], { cwd: '/' });
  await kernel.umount('/usr/local');
  const r = await kernel.run(['stat', '-c', '%a %U', '/usr/local/share/pnpm'], { cwd: '/' });
  assert.equal(r.stdout, '755 root\n', r.stderr);
});

test('a new process finds PNPM_HOME on a hostfs /usr whose host came up after the mount, or removed it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-usr-'));
  const proxy = await hostfsProxy({ folders: { usr: dir } });
  let up = false;
  const kernel = await createNodeKernel({
    hostfs: async (source, { readonly }) => {
      if (!up) throw Object.assign(new Error('link down'), { code: 'ENOTCONN' });
      const response = await fetch(`${proxy.url}/api/hostfs/grant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': proxy.key },
        body: JSON.stringify({ mount: source, readonly }),
      });
      return { url: proxy.url, ...(await response.json()) };
    },
  });
  t.after(async () => {
    kernel.terminate();
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  const entry = await kernel.mount({ type: 'hostfs', source: 'usr', target: '/usr' });
  assert.equal(entry.state, 'nomedium');
  up = true;
  while ((await kernel.mounts()).find((m) => m.target === '/usr')?.state !== 'ok') {
    await new Promise((done) => setTimeout(done, 50));
  }
  const r = await kernel.run(['bash', '-c', 'test -d /usr/local/share/pnpm && echo there'], {
    cwd: '/',
  });
  assert.equal(r.stdout, 'there\n', r.stderr);
  assert.ok((await stat(join(dir, 'local/share/pnpm'))).isDirectory());
  await rm(join(dir, 'local'), { recursive: true });
  const until = Date.now() + 5000;
  while (!(await stat(join(dir, 'local/share/pnpm')).catch(() => undefined))) {
    assert.ok(Date.now() < until, 'PNPM_HOME is made again after the host removed it');
    await kernel.run(['true'], { cwd: '/' });
    await new Promise((done) => setTimeout(done, 50));
  }
});

test('a path with .. after a symlink runs what the file system finds there, with its exec check', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  const script = [
    'mkdir -p /opt/store/pkg /opt/store/tools /opt/app',
    'ln -s /opt/store/pkg /opt/app/pkg',
    'cp /node_modules/@ai-ecoverse/wasm-bash/bin/bash* /opt/store/tools/',
    'printf "#!/bin/sh\\necho script ran\\n" > /opt/store/tools/hello.sh',
    'cp /opt/store/tools/hello.sh /opt/store/tools/closed.sh',
    'chmod 755 /opt/store/tools/bash /opt/store/tools/hello.sh',
    'chmod 644 /opt/store/tools/closed.sh',
    'cd /opt/app',
    'pkg/../tools/hello.sh',
    '/opt/app/pkg/../tools/bash -c "echo by path"',
    'pkg/../tools/closed.sh; echo "closed $?"',
  ].join('\n');
  await kernel.users.add({ name: 'cone' });
  const r = await kernel.run(['bash', '-c', script], { cwd: '/' });
  assert.equal(r.stdout, 'script ran\nby path\nclosed 126\n', r.stderr);
  const user = await kernel.run(['bash', '-c', 'cd /opt/app && pkg/../tools/hello.sh'], {
    cwd: '/home/cone',
    user: 'cone',
  });
  assert.equal(user.stdout, 'script ran\n', user.stderr);
});

test('a path with .. needs search permission on the directories it goes through, and a sudo process follows no untrusted link there', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.users.add({ name: 'cone', groups: ['sudo'] });
  const setup = [
    'mkdir -p /usr/lib /srv/closed && ln -s /usr/lib /srv/closed/link && chmod 700 /srv/closed',
    "printf '%s\\n' 'NOPASSWD cone Cmnd *' > /etc/sudoers.d/cone && chmod 440 /etc/sudoers.d/cone",
    '/srv/closed/link/../bin/echo root ran',
  ].join('\n');
  const root = await kernel.run(['bash', '-c', setup], { cwd: '/' });
  assert.equal(root.stdout, 'root ran\n', root.stderr);
  const cone = [
    '/srv/closed/link/../bin/echo cone ran; echo "closed $?"',
    'ln -s /usr/lib /home/cone/mine && /home/cone/mine/../bin/echo own link',
    'sudo bash -c \'/home/cone/mine/../bin/echo sudo ran; echo "sudo $?"\'',
    "sudo bash -c '/usr/lib/../bin/echo sudo plain'",
  ].join('\n');
  const r = await kernel.run(['bash', '-c', cone], { cwd: '/home/cone', user: 'cone' });
  assert.match(r.stderr, /\/srv\/closed\/link\/\.\.\/bin\/echo: Permission denied/);
  assert.match(r.stderr, /\/home\/cone\/mine\/\.\.\/bin\/echo: Permission denied/);
  assert.equal(r.stdout, 'closed 126\nown link\nsudo 126\nsudo plain\n');
});

test("a package command's WASI wasm run by path runs as that command, in the caller's catalog", async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  const rg = await readFile(new URL('wasi-ripgrep/bin/rg.wasm', modules));
  const manifest = (name) =>
    JSON.stringify({
      name,
      slicc: {
        abi: 'wasi',
        commands: { [name]: { wasm: 'bin/rg.wasm', env: { RIPGREP_CONFIG_PATH: './rgrc' } } },
      },
    });
  const own = '/home/cone/.local/share/pnpm/global/5/g1/node_modules/rgcone';
  await kernel.users.add({ name: 'cone' });
  for (const [dir, name] of [
    ['/node_modules/rgenv', 'rgenv'],
    [own, 'rgcone'],
  ]) {
    await kernel.writeFile(`${dir}/package.json`, manifest(name));
    await kernel.writeFile(`${dir}/bin/rg.wasm`, rg);
    await kernel.writeFile(`${dir}/rgrc`, '--count\n');
  }
  const prep = `chmod 755 /node_modules/rgenv/bin/rg.wasm ${own}/bin/rg.wasm && chown -R cone ${own}`;
  assert.equal((await kernel.run(['bash', '-c', prep], { cwd: '/' })).status, 0);
  await kernel.writeFile('/srv/f', 'x\nx\n');
  const root = [
    '/node_modules/rgenv/bin/rg.wasm x /srv/f',
    'cp /node_modules/rgenv/bin/rg.wasm /tmp/rg.wasm && chmod 755 /tmp/rg.wasm && /tmp/rg.wasm x /srv/f',
  ].join('\n');
  const r = await kernel.run(['bash', '-c', root], { cwd: '/' });
  assert.equal(r.stdout, '2\nx\nx\n', r.stderr);
  const mine = await kernel.run(['bash', '-c', `${own}/bin/rg.wasm x /srv/f`], {
    cwd: '/home/cone',
    user: 'cone',
  });
  assert.equal(mine.stdout, '2\n', mine.stderr);
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
