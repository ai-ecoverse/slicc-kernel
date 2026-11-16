import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  computerWith,
  nodeStorage,
  run,
  shellKernel,
  sliccBackend,
  Workspace,
  workspaceDriver,
} from './computer-harness.mjs';

const MOUNT = '/workspace';
const RO = `${MOUNT}/ro`;
const ORIGINAL = 'original\n';
const NESTED = 'nested\n';

function readOnlyMount(files, version = 'v1') {
  return {
    kind: 'test-files',
    mode: 'read-only',
    strategy: 'eager',
    version,
    async materialize(api) {
      for (const [name, text] of Object.entries(files)) {
        const at = `${api.root}/${name}`;
        await api.mkdir(at.slice(0, at.lastIndexOf('/')));
        await api.writeFile(at, new Blob([text]).stream());
      }
    },
  };
}

const FILES = { 'a.txt': ORIGINAL, 'sub/b.txt': NESTED };

async function textOf(fs, path) {
  return fs.readFile(path, 'utf8');
}

async function listing(fs, dir) {
  const out = [];
  for (const entry of await fs.readdir(dir)) {
    const at = `${dir}/${entry.name}`;
    out.push(entry.name);
    if (entry.isDirectory)
      for (const name of await listing(fs, at)) out.push(`${entry.name}/${name}`);
  }
  return out.sort();
}

const REFUSED = [
  'echo x > ro/a.txt',
  ': > ro/a.txt',
  'exec 3>ro/a.txt',
  'exec 3<>ro/a.txt',
  'touch ro/a.txt',
  'touch -d @0 ro/a.txt',
  'echo x >> ro/a.txt',
  'echo x > ro/new.txt',
  'echo x > ro/sub/b.txt',
  'dd if=/dev/zero of=ro/a.txt count=1',
  'dd if=/dev/zero of=ro/a.txt count=1 conv=notrunc',
  'truncate -s 0 ro/a.txt',
  'mkdir ro/dir',
  'mkdir -p ro/sub/deeper',
  'rm ro/a.txt',
  'rm -f ro/a.txt',
  'rm -r ro/sub',
  'rmdir ro/sub',
  'mv ro/a.txt ro/b.txt',
  'mv ro/a.txt out.txt',
  'echo y > in.txt && mv in.txt ro/in.txt',
  'chmod 600 ro/a.txt',
  'chmod 700 ro/sub',
  'ln -s a.txt ro/link',
  'ln ro/a.txt ro/hard',
  'ln -sf ro/a.txt via && echo x > via',
  `ln -sf ${RO}/a.txt via-abs && echo x > via-abs`,
  'ln -sf ro via-dir && echo x > via-dir/a.txt',
];

const ASYNC = { blocking: 'async', emscripten: 'kernel' };

function refusesEveryChange(label, backend, kernelOptions) {
  describe(`a read-only Workspace mount, ${label}`, () => {
    let computer;
    let ws;
    let tree;
    before(async () => {
      computer = await computerWith({
        backend,
        kernelOptions,
        mounts: { [RO]: readOnlyMount(FILES) },
      });
      ws = computer.workspace;
      tree = await listing(ws.fs, RO);
    });
    after(() => computer.close());

    for (const command of REFUSED) {
      it(`refuses \`${command}\` with EROFS where it starts`, async () => {
        const result = await run(ws, command);
        const shown = JSON.stringify(result);
        assert.notEqual(result.exitCode, 0, shown);
        assert.match(result.stderr, /Read-only file system/, shown);
        assert.doesNotMatch(result.stderr, /write error|closing|close failed/, shown);
        assert.equal(await textOf(ws.fs, `${RO}/a.txt`), ORIGINAL);
        assert.equal(await textOf(ws.fs, `${RO}/sub/b.txt`), NESTED);
        assert.deepEqual(await listing(ws.fs, RO), tree);
        assert.equal((await ws.fs.stat(`${RO}/a.txt`)).mode & 0o777, 0o644);
      });
    }

    it('reads it, says it is not writable, and writes next to it', async () => {
      const script = [
        'set -e',
        'cat ro/a.txt ro/sub/b.txt',
        'test -w ro/a.txt && echo writable || echo read-only',
        'test -w ro && echo writable || echo read-only',
        'echo ok > beside.txt',
        'cat beside.txt',
        'mkdir -p ro/sub',
        'ls ro',
      ].join('\n');
      const result = await run(ws, script);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, `${ORIGINAL}${NESTED}read-only\nread-only\nok\na.txt\nsub\n`);
      assert.equal(await textOf(ws.fs, `${MOUNT}/beside.txt`), 'ok\n');
    });

    it('still finds a loop of symlinks a loop', async () => {
      const result = await run(
        ws,
        'ln -sfn loop loop; ln -sfn self/x self; echo x > loop/a; echo x > self/a'
      );
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /Symbolic link loop|Too many levels of symbolic links/);
      assert.doesNotMatch(result.stderr, /Read-only file system/);
    });

    it('writes and renames beside it, under the same mount point', async () => {
      const result = await run(
        ws,
        'echo x > beside-new.txt && mv beside-new.txt beside-moved.txt && cat beside-moved.txt'
      );
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, 'x\n');
    });
  });
}

refusesEveryChange('as on Cloudflare, with write-behind', {}, ASYNC);
refusesEveryChange('as on Cloudflare, without write-behind', { writeBehind: false }, ASYNC);
refusesEveryChange('on the blocking runtime', {}, {});

describe('read-only Workspace mounts across connections', () => {
  it('follows the mounts of each Workspace on the same storage and kernel', async () => {
    const kernel = await shellKernel(ASYNC);
    const storage = nodeStorage();
    const open = async (mounts) => {
      const workspace = new Workspace({
        storage,
        backends: [sliccBackend({ kernel: () => kernel })],
        mounts,
      });
      await workspace.ready();
      return workspace;
    };
    try {
      const first = await open({ [RO]: readOnlyMount(FILES) });
      const one = await run(first, 'echo x > ro/a.txt');
      assert.notEqual(one.exitCode, 0, one.stderr);
      await first.close();

      const second = await open({
        [RO]: readOnlyMount({ ...FILES, 'other.txt': 'other\n' }, 'v2'),
        [`${MOUNT}/rw`]: { ...readOnlyMount({ 'w.txt': 'w\n' }), mode: 'read-write' },
      });
      const two = await run(second, 'echo x > ro/other.txt');
      assert.notEqual(two.exitCode, 0, two.stderr);
      assert.match(two.stderr, /Read-only file system/);
      assert.equal(await textOf(second.fs, `${RO}/other.txt`), 'other\n');
      const rw = await run(second, 'echo changed > rw/w.txt && cat rw/w.txt');
      assert.equal(rw.exitCode, 0, rw.stderr);
      assert.equal(rw.stdout, 'changed\n');
      await second.close();
    } finally {
      kernel.terminate();
      storage.close();
    }
  });
});

describe('workspaceDriver below a read-only mount', () => {
  let computer;
  let driver;
  before(async () => {
    computer = await computerWith({ kernelOptions: ASYNC, mounts: { [RO]: readOnlyMount(FILES) } });
    driver = workspaceDriver(computer.workspace.fs, { root: MOUNT });
    await driver.mount();
  });
  after(() => computer.close());

  const write = { write: true, create: false, truncate: false, exclusive: false };
  const refused = { code: 'EROFS' };

  it('refuses every write open, of an existing file or a new one', async () => {
    await assert.rejects(driver.open('/ro/a.txt', { ...write, truncate: true }), refused);
    await assert.rejects(driver.open('/ro/a.txt', write), refused);
    await assert.rejects(driver.open('/ro/new.txt', { ...write, create: true }), refused);
    await assert.rejects(
      driver.open('/ro/new.txt', { ...write, create: true, exclusive: true }),
      refused
    );
    const fh = await driver.open('/ro/a.txt', { ...write, write: false });
    assert.equal(new TextDecoder().decode(await driver.read(fh, 0, 100)), ORIGINAL);
    await driver.release(fh);
    assert.equal(driver.pending(), false);
  });

  it('refuses setattr, mkdir, rmdir, unlink, rename, symlink and link', async () => {
    await assert.rejects(driver.setattr('/ro/a.txt', { size: 0 }), refused);
    await assert.rejects(driver.setattr('/ro/a.txt', { mode: 0o600 }), refused);
    await assert.rejects(driver.setattr('/ro/a.txt', { mtime: 0, atime: 0 }), refused);
    await assert.rejects(driver.mkdir('/ro/d'), refused);
    await assert.rejects(driver.rmdir('/ro/sub'), refused);
    await assert.rejects(driver.unlink('/ro/a.txt'), refused);
    await assert.rejects(driver.rename('/ro/a.txt', '/out.txt'), refused);
    await assert.rejects(driver.rename('/ro', '/elsewhere'), refused);
    await assert.rejects(driver.symlink('a.txt', '/ro/l'), refused);
    assert.equal(await textOf(computer.workspace.fs, `${RO}/a.txt`), ORIGINAL);
  });

  it('marks what is below it read-only, and only that', async () => {
    assert.equal((await driver.getattr('/ro/a.txt')).readonly, true);
    assert.equal((await driver.getattr('/ro')).readonly, true);
    assert.equal((await driver.getattr('/ro/sub')).readonly, true);
    assert.equal((await driver.getattr('/')).readonly, undefined);
  });

  it('answers a mkdir of a directory above it as one that exists', async () => {
    await assert.rejects(driver.mkdir('/'), { code: 'EEXIST' });
  });
});
