import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { hostfsProxy } from './hostfs-proxy.mjs';

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

async function folder(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function mounted(t, options) {
  const kernel = await createNodeKernel(options);
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile('/mnt/h/.keep', '');
  await kernel.mount({ type: 'hostfs', source: 'project', target: '/mnt/h' });
  return kernel;
}

async function appear(path) {
  for (let i = 0; i < 400; i++) {
    if (
      await stat(path).then(
        () => true,
        () => false
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${path} never appeared`);
}

const WAIT = ': > ready$N; while [ ! -e go$N ]; do sleep 0.05; done';

test('hostfs through the Node entry: a host edit mid-read is ESTALE on an inherited or an opened descriptor, so is a removal the kernel has seen, a write in the kernel is not', async (t) => {
  const dir = await folder(t, 'slicc-hostfs-');
  const proxy = await hostfsProxy({
    folders: { project: dir },
    pingMs: 100,
    capabilities: { ranges: true },
  });
  t.after(() => proxy.close());
  await writeFile(join(dir, 'v'), Buffer.alloc(3 * 1024 * 1024, 65));
  for (const name of ['v1', 'v2', 'v3', 'v4']) {
    await writeFile(join(dir, name), Buffer.alloc(3 * 1024 * 1024, 65));
  }
  const kernel = await mounted(t, {
    hostfs: async (source, { readonly }) => proxy.grant(source, readonly),
  });
  assert.deepEqual(
    (await kernel.mounts()).map((m) => [m.type, m.target, m.state]),
    [['hostfs', '/mnt/h', 'ok']]
  );
  const run = (script) => kernel.run(['bash', '-c', script], { cwd: '/mnt/h' });
  await kernel.writeFile('/mnt/h/api', 'from the API');
  assert.equal(await readFile(join(dir, 'api'), 'utf8'), 'from the API');
  assert.equal((await kernel.readFile('/mnt/h/v')).length, 3 * 1024 * 1024);
  await run('rm api');
  assert.equal((await run('head -c 3 v; echo; ls')).stdout, 'AAA\nv\nv1\nv2\nv3\nv4\n');
  let n = 0;
  const hostEdit = async (script, edit) => {
    n += 1;
    const done = run(`N=${n}; ${script}`);
    await appear(join(dir, `ready${n}`));
    proxy.mute(true);
    await edit();
    await writeFile(join(dir, `go${n}`), '');
    try {
      return await done;
    } finally {
      proxy.mute(false);
    }
  };
  const append = (name) => () => appendFile(join(dir, name), 'x\n');
  const inherited = await hostEdit(
    `exec 3< v1; head -c 1 <&3 >/dev/null; ${WAIT}; dd bs=1048576 skip=2 count=1 <&3 of=/dev/null; echo "rc $?"`,
    append('v1')
  );
  assert.equal(inherited.stdout, 'rc 1\n');
  assert.match(inherited.stderr, /Stale file handle/);
  const opened = await hostEdit(
    `exec 3< v2; read -r -N 2 -u 3 a; ${WAIT}; read -r -N 2000000 -u 3 b; echo "rc $? \${#a}"`,
    append('v2')
  );
  assert.equal(opened.stdout, 'rc 1 2\n');
  assert.match(opened.stderr, /Stale file handle/);
  const shrunk = await hostEdit(
    `exec 3< v3; read -r -N 1 -u 3 a; ${WAIT}; dd bs=1048576 count=1 <&3 of=/dev/null; echo "rc $?"`,
    () => writeFile(join(dir, 'v3'), '')
  );
  assert.equal(shrunk.stdout, 'rc 1\n');
  assert.match(shrunk.stderr, /Stale file handle/);
  const removed = await hostEdit(
    `exec 3< v4; read -r -N 1 -u 3 a; ${WAIT}; dd bs=1048576 skip=1 count=1 <&3 of=/dev/null; echo "rc $?"`,
    async () => {
      await rm(join(dir, 'v4'));
      const end = Date.now() + 120_000;
      while ((await run('test -e v4')).status === 0) {
        assert.ok(Date.now() < end, 'the kernel never saw v4 gone');
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  );
  assert.equal(removed.stdout, 'rc 1\n');
  assert.match(removed.stderr, /Stale file handle/);
  await writeFile(join(dir, 'w'), Buffer.alloc(3 * 1024 * 1024, 66));
  const local = await run(
    'exec 3< w; head -c 1 <&3 >/dev/null; echo x | tee -a w >/dev/null; dd bs=1048576 skip=2 count=2 <&3 2>/dev/null | wc -c; echo "rc $?"'
  );
  assert.equal(local.stdout, '1048577\nrc 0\n', local.stderr);
});

const ORIGIN = 'http://localhost:8787';

async function originBound(t) {
  const dir = await folder(t, 'slicc-origin-');
  await writeFile(join(dir, 'hello'), 'from the host\n');
  const proxy = await hostfsProxy({ folders: { project: dir }, origins: [ORIGIN] });
  t.after(() => proxy.close());
  const hostfs = async (mount, { readonly }) => proxy.grant(mount, readonly, ORIGIN);
  return { dir, hostfs };
}

test('hostfs from the Node entry against a host that binds tokens to an origin sends the origin the token was granted to, with no global fetch patched', async (t) => {
  const { dir, hostfs } = await originBound(t);
  const kernel = await mounted(t, { hostfs, hostfsOrigin: ORIGIN });
  assert.deepEqual(
    (await kernel.mounts()).map((m) => [m.type, m.state]),
    [['hostfs', 'ok']]
  );
  const r = await kernel.run(['bash', '-c', 'cat hello; echo back > there; ls'], { cwd: '/mnt/h' });
  assert.equal(r.stdout, 'from the host\nhello\nthere\n');
  assert.equal(await readFile(join(dir, 'there'), 'utf8'), 'back\n');
  const bare = await mounted(t, { hostfs });
  assert.deepEqual(
    (await bare.mounts()).map((m) => [m.type, m.state]),
    [['hostfs', 'nomedium']]
  );
});

test('hostfs from the Node entry against a host that binds tokens to an origin goes through hostfsFetch, with the origin added when both are given', async (t) => {
  const { hostfs } = await originBound(t);
  const seen = [];
  const hostfsFetch = (url, init) => {
    seen.push([new URL(url).pathname, new Headers(init.headers).get('Origin')]);
    return fetch(url, init);
  };
  const own = await mounted(t, {
    hostfs,
    hostfsFetch: (url, init) =>
      hostfsFetch(url, { ...init, headers: { ...init.headers, Origin: ORIGIN } }),
  });
  assert.equal((await own.run(['cat', '/mnt/h/hello'])).stdout, 'from the host\n');
  const both = await mounted(t, { hostfs, hostfsFetch, hostfsOrigin: ORIGIN });
  assert.equal((await both.run(['cat', '/mnt/h/hello'])).stdout, 'from the host\n');
  assert.ok(seen.length > 1);
  assert.deepEqual(
    seen.filter(([path]) => !path.startsWith('/api/hostfs')),
    []
  );
  assert.ok(seen.some(([path, origin]) => path === '/api/hostfs/watch' && origin === ORIGIN));
});
