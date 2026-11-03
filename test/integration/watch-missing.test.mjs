import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachKernel, createNodeKernel } from '../../dist/node.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function watching(client, paths, recursive) {
  const heard = [];
  const watch = await client.fs.watch(paths, { recursive }, (change) => heard.push(change));
  const quiet = async () => {
    await settle();
    return [...new Set(heard.splice(0).flatMap((change) => change.paths ?? ['overflow']))].sort();
  };
  return { watch, quiet };
}

test('a client watches paths that don’t exist yet, under a missing directory or a file, and hears each one created, removed and created again', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  await kernel.users.add({ name: 'cone' });
  const cone = await attachKernel(await kernel.connect({ user: 'cone' }));
  const root = await attachKernel(await kernel.connect());
  await root.fs.writeFile('/home/cone/notes', 'x');
  const flat = await watching(
    cone,
    ['/home/cone/sprinkles', '/scoops', '/home/cone/notes/inner'],
    false
  );
  const deep = await watching(cone, ['/home/cone/.slicc/a'], true);
  assert.equal(await cone.fs.exists('/home/cone/.slicc'), false);

  await cone.fs.mkdir('/home/cone/sprinkles');
  await root.fs.mkdir('/scoops/s1');
  await cone.fs.mkdir('/home/cone/.slicc/a/b');
  await cone.fs.writeFile('/home/cone/.slicc/a/b/c', 'y');
  await cone.fs.writeFile('/home/cone/.slicc/other', 'z');
  assert.deepEqual(await flat.quiet(), ['/home/cone/sprinkles', '/scoops', '/scoops/s1']);
  assert.deepEqual(await deep.quiet(), [
    '/home/cone/.slicc',
    '/home/cone/.slicc/a',
    '/home/cone/.slicc/a/b',
    '/home/cone/.slicc/a/b/c',
  ]);

  await root.fs.rm('/home/cone/notes');
  await root.fs.mkdir('/home/cone/notes/inner');
  assert.deepEqual(await flat.quiet(), ['/home/cone/notes', '/home/cone/notes/inner']);

  await cone.fs.rm('/home/cone/.slicc');
  await cone.fs.rm('/home/cone/sprinkles');
  assert.deepEqual(await deep.quiet(), ['/home/cone/.slicc']);
  assert.deepEqual(await flat.quiet(), ['/home/cone/sprinkles']);
  await cone.fs.mkdir('/home/cone/.slicc/a');
  await cone.fs.rename('/home/cone/.slicc/a', '/home/cone/.slicc/moved');
  await cone.fs.writeFile('/home/cone/sprinkles', 'now a file');
  assert.deepEqual(await deep.quiet(), ['/home/cone/.slicc', '/home/cone/.slicc/a']);
  assert.deepEqual(await flat.quiet(), ['/home/cone/sprinkles']);
  flat.watch.close();
  deep.watch.close();
});

test('watching a missing path is checked against the directories that exist: one under a directory the client may not search is EACCES, for root it is a watch', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  await kernel.users.add({ name: 'cone' });
  const cone = await attachKernel(await kernel.connect({ user: 'cone' }));
  const root = await attachKernel(await kernel.connect());
  await root.fs.mkdir('/root/.pi');
  const memory = '/root/.pi/agent/agent-memory';
  await assert.rejects(
    cone.fs.watch([memory], { recursive: true }, () => {}),
    (err) => err.code === 'EACCES'
  );
  const { watch, quiet } = await watching(root, [memory], true);
  await root.fs.mkdir(`${memory}/day`);
  assert.deepEqual(await quiet(), ['/root/.pi/agent', memory, `${memory}/day`]);
  watch.close();
});
