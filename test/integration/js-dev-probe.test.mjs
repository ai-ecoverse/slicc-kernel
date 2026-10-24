import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const PROGRAM = readFileSync(
  new URL('fixtures/jsdevprobe/bin/jsdevprobe.mjs', import.meta.url),
  'utf8'
);

test('a JS path op through a symlink into /dev, or a symlinked dir, still reaches the device, and a missing path costs one kernel call (#1595)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/jsdevprobe/package.json',
    JSON.stringify({
      name: 'jsdevprobe',
      slicc: { commands: { jsdevprobe: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/jsdevprobe/main.mjs', PROGRAM);
  const r = await kernel.run(['jsdevprobe'], { cwd: '/' });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.deepEqual(got.link.slice(1), [true, 0]);
  assert.deepEqual(got.dir.slice(1), [true, 0]);
  assert.deepEqual(got.async.slice(1), [true, 0]);
  assert.deepEqual(got.errors, ['ENOENT', 'ENOENT', false]);
  assert.deepEqual(got.calls, [1, 1, 1, 1]);
});

const GUARDED = `export default async function main(ctx) {
  const { sync } = ctx;
  if (ctx.argv[1] === 'setup') {
    sync.fs.mkdir('/tmp/secret');
    sync.fs.symlink('/dev', '/tmp/secret/dev');
    sync.fs.chmod('/tmp/secret', 0o700);
    sync.fs.mkdir('/tmp/open');
    sync.fs.chmod('/tmp/open', 0o755);
    sync.fs.symlink('/tmp/secret/dev', '/tmp/open/l');
    sync.fs.symlink('/tmp/secret', '/tmp/open/m');
    return 0;
  }
  const code = (fn) => {
    try {
      const got = fn();
      return got === false ? 'false' : 'device';
    } catch (err) {
      return err.code;
    }
  };
  const out = [];
  for (const p of ['/tmp/secret/dev/null', '/tmp/open/l/null', '/tmp/open/m/dev/null']) {
    out.push([code(() => sync.fs.stat(p)), code(() => sync.fs.lstat(p)), code(() => sync.fs.readFile(p)), code(() => sync.fs.exists(p))]);
  }
  await ctx.write(1, new TextEncoder().encode(JSON.stringify(out) + '\\n'));
  return 0;
}`;

test('a symlink into /dev behind a directory the caller cannot search gives the caller EACCES or ENOENT, never the device, as the walk did process-side (#1595)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  await kernel.users.add({ name: 'cone' });
  await kernel.writeFile(
    '/node_modules/jsguard/package.json',
    JSON.stringify({
      name: 'jsguard',
      slicc: { commands: { jsguard: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/jsguard/main.mjs', GUARDED);
  assert.equal((await kernel.run(['jsguard', 'setup'], { cwd: '/' })).status, 0);
  const root = await kernel.run(['jsguard'], { cwd: '/' });
  assert.deepEqual(
    JSON.parse(root.stdout),
    Array(3).fill(['device', 'device', 'device', 'device']),
    root.stderr
  );
  const cone = await kernel.run(['jsguard'], { cwd: '/', user: 'cone' });
  for (const row of JSON.parse(cone.stdout)) {
    for (const got of row) assert.ok(['EACCES', 'ENOENT', 'false'].includes(got), cone.stdout);
  }
});
