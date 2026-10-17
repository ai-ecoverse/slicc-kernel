import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import wabtInit from 'wabt';
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

const PACKAGE = JSON.stringify({
  name: 'reach',
  slicc: { commands: { reach: { abi: 'js', module: 'bin/reach.mjs' } } },
});

const PROGRAM = `export default async function main(ctx) {
  const listener = await ctx.net.listen({ port: 7411 });
  const served = (async () => {
    for await (const c of listener) {
      const w = c.writable.getWriter();
      await w.write(new TextEncoder().encode('hi'));
      await w.close();
      await c.close();
    }
  })();
  const out = [];
  for (const name of ctx.argv.slice(1)) {
    try {
      const c = await ctx.net.connect({ host: name, port: 7411 });
      const r = await c.readable.getReader().read();
      out.push(name + ' ' + new TextDecoder().decode(r.value));
      await c.close();
    } catch (e) {
      out.push(name + ' ' + (e.code ?? e.name));
    }
  }
  await listener.close();
  await served.catch(() => undefined);
  await ctx.write(1, out.join('\\n') + '\\n');
}
`;

test('the kernel resolver honours names added to a real /etc/hosts, sees a change at once, and drops them with the file (#898)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile('/node_modules/reach/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/reach/bin/reach.mjs', PROGRAM);
  const reach = async (...names) => (await kernel.run(['reach', ...names], { cwd: '/' })).stdout;
  const sh = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  const before = await reach('zzydb', 'localhost');
  assert.match(before, /^zzydb (?!hi)/);
  assert.match(before, /\nlocalhost hi\n$/);
  await sh("echo '127.0.0.1 zzydb zzydb.internal # added' >> /etc/hosts");
  assert.equal(
    await reach('zzydb', 'ZZYDB.internal.', 'localhost'),
    'zzydb hi\nZZYDB.internal. hi\nlocalhost hi\n'
  );
  await sh("echo '127.0.0.1 later' >> /etc/hosts");
  assert.equal(await reach('later'), 'later hi\n');
  await sh('rm /etc/hosts');
  assert.match(await reach('zzydb', 'localhost'), /^zzydb (?!hi).*\nlocalhost hi\n$/);
});

test('under enforce a user can neither create, replace, remove nor redirect /etc/hosts, and what the resolver answers stays the same (#910)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile('/node_modules/reach/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/reach/bin/reach.mjs', PROGRAM);
  await kernel.users.add({ name: 'cone' });
  const reach = async (...names) => (await kernel.run(['reach', ...names], { cwd: '/' })).stdout;
  const root = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  const cone = (script) => kernel.run(['bash', '-c', script], { cwd: '/tmp', user: 'cone' });
  const refused = /Permission denied|Operation not permitted/;
  await cone("printf '127.0.0.1 zzyx\\n' > /tmp/h");
  const create = await cone("echo '127.0.0.1 zzyx' > /etc/hosts");
  assert.notEqual(create.status, 0);
  assert.match(create.stderr, refused);
  assert.notEqual((await root('test -e /etc/hosts')).status, 0);
  assert.match(await reach('zzyx'), /^zzyx (?!hi)/);
  await root("echo '127.0.0.1 known' > /etc/hosts && chmod 644 /etc/hosts");
  for (const attempt of [
    'rm -f /etc/hosts',
    'mv /tmp/h /etc/hosts',
    'ln -sf /tmp/h /etc/hosts',
    "echo '127.0.0.1 zzyx' >> /etc/hosts",
  ]) {
    const r = await cone(attempt);
    assert.notEqual(r.status, 0, attempt);
    assert.match(r.stderr, refused, attempt);
    assert.equal((await root('cat /etc/hosts')).stdout, '127.0.0.1 known\n', attempt);
    assert.equal((await root('stat -c %F /etc/hosts')).stdout, 'regular file\n', attempt);
    assert.match(await reach('known', 'zzyx'), /^known hi\nzzyx (?!hi)/, attempt);
  }
});

const HOLD = `export default async function main(ctx) {
  const listener = await ctx.net.listen({ port: 7411 });
  await ctx.fs.writeFile('/tmp/held', '');
  const c = await listener.accept();
  await c.close();
  await listener.close();
  await ctx.write(1, 'accepted\\n');
}
`;

const EXIT_WAT =
  '(module (import "wasi_snapshot_preview1" "proc_exit" (func $e (param i32))) (memory (export "memory") 1) (func (export "_start") i32.const 0 call $e))';

const PROBE_IMPORTS = `export function createImports(ctx) {
  if (ctx.tid === 1) {
    let said;
    try {
      const fd = ctx.net.connect({ host: 'localhost', port: 7411 });
      ctx.syscall({ op: 'fd-close', fd });
      said = 'imports localhost connected';
    } catch (e) {
      said = 'imports localhost ' + (e.code ?? e.message);
    }
    ctx.syscall({ op: 'fd-write', fd: 1, body: new TextEncoder().encode(said + '\\n') });
  }
  return {};
}
`;

test('policy is on the address a name resolves to: with localhost and a new name mapped to 203.0.113.5 and no uplink, both are unreachable by name, and the imports path to localhost still reaches the loopback (#910)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile('/node_modules/reach/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/reach/bin/reach.mjs', PROGRAM);
  const wabt = await wabtInit();
  const mod = wabt.parseWat('exit.wat', EXIT_WAT);
  await kernel.writeFile(
    '/node_modules/probe/package.json',
    JSON.stringify({
      name: 'probe',
      slicc: {
        abi: 'wasi',
        commands: { probe: { wasm: 'bin/probe.wasm', imports: 'host/probe.mjs' } },
      },
    })
  );
  await kernel.writeFile(
    '/node_modules/probe/bin/probe.wasm',
    new Uint8Array(mod.toBinary({}).buffer)
  );
  mod.destroy();
  await kernel.writeFile('/node_modules/probe/host/probe.mjs', PROBE_IMPORTS);
  await kernel.run(['bash', '-c', "echo '203.0.113.5 localhost zzyfresh' > /etc/hosts"], {
    cwd: '/',
  });
  assert.equal(
    (await kernel.run(['reach', 'zzyfresh', '203.0.113.5', 'localhost', '127.0.0.1'], { cwd: '/' }))
      .stdout,
    'zzyfresh ENETUNREACH\n203.0.113.5 ENETUNREACH\nlocalhost ENETUNREACH\n127.0.0.1 hi\n'
  );
  await kernel.writeFile('/node_modules/reach/bin/hold.mjs', HOLD);
  await kernel.writeFile(
    '/node_modules/reach/package.json',
    JSON.stringify({
      name: 'reach',
      slicc: {
        commands: {
          reach: { abi: 'js', module: 'bin/reach.mjs' },
          hold: { abi: 'js', module: 'bin/hold.mjs' },
        },
      },
    })
  );
  const held = kernel.run(['hold'], { cwd: '/' });
  for (let i = 0; i < 200; i++) {
    if ((await kernel.run(['bash', '-c', 'test -e /tmp/held'], { cwd: '/' })).status === 0) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.deepEqual(await kernel.run(['probe'], { cwd: '/' }), {
    status: 0,
    stdout: 'imports localhost connected\n',
    stderr: '',
  });
  assert.equal((await held).stdout, 'accepted\n');
});
