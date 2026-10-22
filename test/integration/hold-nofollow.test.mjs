import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryMeta } from '../../src/fs/meta.ts';
import { OpfsFs } from '../../src/fs/opfs.ts';
import { UnlinkedKeeper } from '../../src/fs/unlinked.ts';
import { HeldPaths, HeldSet } from '../../src/mount/mount-fs.ts';
import { memoryRoot } from '../../src/node/memory-root.ts';
import { dispatchSyncFs } from '../../src/realm/sync-fs-dispatch.ts';
import { mintSyncFsToken } from '../../src/realm/sync-fs-token-registry.ts';

const locks = { request: () => new Promise(() => undefined), query: async () => ({ held: [] }) };

function world() {
  const base = new OpfsFs(memoryRoot(), new MemoryMeta());
  const plain = {};
  for (const key of Object.getOwnPropertyNames(OpfsFs.prototype)) {
    if (key !== 'constructor' && typeof base[key] === 'function') plain[key] = base[key].bind(base);
  }
  const held = new HeldSet(() => undefined);
  const holder = new HeldPaths();
  held.add(holder);
  const keeper = new UnlinkedKeeper(plain, held, () => '/', { locks });
  return { base, plain, keeper, holder };
}

test('a no-follow hold refuses a symlink that lands at its path while it resolves, even one whose creation began before the hold', async () => {
  const { base, plain, keeper, holder } = world();
  await base.writeFile('/secret', 'SECRET');
  const start = Promise.withResolvers();
  const landed = Promise.withResolvers();
  const symlink = plain.symlink;
  plain.symlink = async (...args) => {
    await start.promise;
    await symlink(...args);
    landed.resolve();
    await new Promise((r) => setTimeout(r, 20));
  };
  const lstat = plain.lstat;
  let first = true;
  plain.lstat = async (p, ...rest) => {
    try {
      return await lstat(p, ...rest);
    } finally {
      if (p === '/racy' && first) {
        first = false;
        start.resolve();
      }
    }
  };
  const realpath = plain.realpath;
  plain.realpath = async (p, follow) => {
    if (p === '/racy' && follow) await landed.promise;
    return realpath(p, follow);
  };
  const fs = keeper.wrap();
  const token = mintSyncFsToken({
    fs,
    cwd: '/',
    replacements: keeper,
    hold: (p, on, open, real, handle) => holder.hold(p, on, open, real, handle),
  });
  const linking = fs.symlink('/secret', '/racy');
  await new Promise((r) => setTimeout(r, 5));
  const held = await dispatchSyncFs({ token, op: 'hold', path: '/racy', mode: 3, nofollow: true });
  await linking;
  const read = held.ok
    ? await dispatchSyncFs({ token, op: 'read', path: '/racy', handle: held.json })
    : undefined;
  assert.deepEqual(
    { ok: held.ok, errno: held.errno, read: read && new TextDecoder().decode(read.bytes) },
    { ok: false, errno: 'ELOOP', read: undefined }
  );
});

test('a no-follow hold of a regular file holds it and reads it; of a name that is gone it is ENOENT', async () => {
  const { base, keeper, holder } = world();
  await base.writeFile('/plain', 'plain');
  const fs = keeper.wrap();
  const token = mintSyncFsToken({
    fs,
    cwd: '/',
    replacements: keeper,
    hold: (p, on, open, real, handle) => holder.hold(p, on, open, real, handle),
  });
  const held = await dispatchSyncFs({ token, op: 'hold', path: '/plain', mode: 3, nofollow: true });
  assert.equal(held.ok, true);
  const read = await dispatchSyncFs({ token, op: 'read', path: '/plain', handle: held.json });
  assert.equal(new TextDecoder().decode(read.bytes), 'plain');
  const gone = await dispatchSyncFs({ token, op: 'hold', path: '/gone', mode: 3, nofollow: true });
  assert.deepEqual([gone.ok, gone.errno], [false, 'ENOENT']);
});
