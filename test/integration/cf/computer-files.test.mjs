import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { computerWith, run } from './computer-harness.mjs';

const MOUNT = '/workspace';

function permissions(st) {
  const type = st.isDirectory ? 'd' : st.isSymbolicLink ? 'l' : '-';
  const bits = st.isSymbolicLink ? 0o777 : st.mode & 0o777;
  const rwx = [6, 3, 0]
    .map((shift) => {
      const part = (bits >> shift) & 7;
      return `${part & 4 ? 'r' : '-'}${part & 2 ? 'w' : '-'}${part & 1 ? 'x' : '-'}`;
    })
    .join('');
  return `${type}${rwx}`;
}

describe('the Workspace mounted in the kernel', () => {
  let computer;
  let ws;
  before(async () => {
    computer = await computerWith();
    ws = computer.workspace;
  });
  after(() => computer.close());

  it('reads a file written with workspace.fs with cat, and the reverse', async () => {
    await ws.fs.mkdir(`${MOUNT}/both`, { recursive: true });
    await ws.fs.writeFile(`${MOUNT}/both/from-ws.txt`, 'written by the Workspace\n');
    const read = await run(ws, 'cat both/from-ws.txt');
    assert.equal(read.exitCode, 0, read.stderr);
    assert.equal(read.stdout, 'written by the Workspace\n');

    const wrote = await run(ws, 'printf "written by bash\\n" > both/from-bash.txt');
    assert.equal(wrote.exitCode, 0, wrote.stderr);
    assert.equal(await ws.fs.readFile(`${MOUNT}/both/from-bash.txt`, 'utf8'), 'written by bash\n');
  });

  it('lands mkdir -p, mv, rm -r, ln -s and chmod +x in the Workspace', async () => {
    const script = [
      'set -e',
      'mkdir -p tree/a/b/c',
      'echo leaf > tree/a/b/c/leaf.txt',
      'mv tree/a tree/moved',
      'ln -s moved/b/c/leaf.txt tree/link',
      'mkdir -p tree/doomed/inner && echo x > tree/doomed/inner/x',
      'rm -r tree/doomed',
      "printf '#!/bin/bash\\necho ran with %s\\n' '$1' > tree/run.sh",
      'chmod +x tree/run.sh',
      './tree/run.sh arg',
      'cat tree/link',
    ].join('\n');
    const result = await run(ws, script);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'ran with arg\nleaf\n');

    assert.equal((await ws.fs.lstat(`${MOUNT}/tree/moved/b/c`)).isDirectory, true);
    await assert.rejects(ws.fs.lstat(`${MOUNT}/tree/a`), { code: 'ENOENT' });
    await assert.rejects(ws.fs.lstat(`${MOUNT}/tree/doomed`), { code: 'ENOENT' });
    assert.equal((await ws.fs.lstat(`${MOUNT}/tree/link`)).isSymbolicLink, true);
    assert.equal(await ws.fs.readlink(`${MOUNT}/tree/link`), 'moved/b/c/leaf.txt');
    assert.equal((await ws.fs.stat(`${MOUNT}/tree/run.sh`)).mode & 0o777, 0o755);
  });

  it('shows in ls -la what the Workspace shows', async () => {
    const dir = `${MOUNT}/listing`;
    await ws.fs.mkdir(`${dir}/sub`, { recursive: true });
    await ws.fs.writeFile(`${dir}/private`, 'secret', { mode: 0o600 });
    await ws.fs.writeFile(`${dir}/tool`, '#!/bin/bash\n', { mode: 0o755 });
    await ws.fs.writeFile(`${dir}/plain`, 'x'.repeat(1234));
    await ws.fs.symlink('plain', `${dir}/pointer`);
    await ws.fs.chmod(`${dir}/sub`, 0o700);

    const result = await run(ws, 'ls -la --time-style=+%s listing');
    assert.equal(result.exitCode, 0, result.stderr);
    const rows = result.stdout
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map((line) => line.split(/\s+/))
      .filter((cols) => cols[6] !== '.' && cols[6] !== '..');
    const names = rows.map((cols) => cols[6]).sort();
    const listed = (await ws.fs.readdir(dir)).map((entry) => entry.name).sort();
    assert.deepEqual(names, listed);
    for (const [perms, , , , size, mtime, name, arrow, target] of rows) {
      const st = await ws.fs.lstat(`${dir}/${name}`);
      assert.equal(perms, permissions(st), name);
      assert.equal(Number(mtime), Math.floor(st.mtime / 1000), name);
      if (!st.isDirectory) assert.equal(Number(size), st.size, name);
      if (st.isSymbolicLink) {
        assert.equal(arrow, '->');
        assert.equal(target, await ws.fs.readlink(`${dir}/${name}`));
      }
    }
  });

  it('appends, truncates and overwrites in the middle of a file', async () => {
    const script = [
      'set -e',
      'mkdir -p edits',
      'echo one > edits/f',
      'echo two >> edits/f',
      'truncate -s 6 edits/f',
      'printf XY | dd of=edits/f bs=1 seek=2 conv=notrunc status=none',
      'truncate -s 9 edits/f',
      'printf Z >> edits/f',
    ].join('\n');
    const result = await run(ws, script);
    assert.equal(result.exitCode, 0, result.stderr);
    const bytes = new Uint8Array(
      await new Response(await ws.fs.readFile(`${MOUNT}/edits/f`)).arrayBuffer()
    );
    assert.deepEqual([...bytes], [...new TextEncoder().encode('onXYtw\0\0\0Z')]);
  });

  it('keeps the mode of a file it rewrites', async () => {
    await ws.fs.writeFile(`${MOUNT}/kept.sh`, 'old', { mode: 0o750 });
    const result = await run(ws, 'echo new > kept.sh && cat kept.sh');
    assert.equal(result.stdout, 'new\n');
    assert.equal((await ws.fs.stat(`${MOUNT}/kept.sh`)).mode & 0o777, 0o750);
  });

  it('sees what workspace.fs changes between runs at once', async () => {
    await ws.fs.writeFile(`${MOUNT}/changing.txt`, 'first');
    assert.equal((await run(ws, 'cat changing.txt')).stdout, 'first');
    await ws.fs.writeFile(`${MOUNT}/changing.txt`, 'second, longer');
    assert.equal((await run(ws, 'cat changing.txt')).stdout, 'second, longer');
    await ws.fs.rm(`${MOUNT}/changing.txt`);
    assert.equal((await run(ws, 'test -e changing.txt || echo gone')).stdout, 'gone\n');
  });

  it('answers a hard link the way other link-less mounts do', async () => {
    await ws.fs.writeFile(`${MOUNT}/single.txt`, 'one name');
    const result = await run(ws, 'ln single.txt second.txt');
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /hard link/);
    await assert.rejects(ws.fs.lstat(`${MOUNT}/second.txt`), { code: 'ENOENT' });
  });

  it('reports no owners but the mount options', async () => {
    const result = await run(ws, 'touch owned && stat -c "%u %g" owned && chown 1000 owned');
    assert.equal(result.stdout, '0 0\n');
    assert.notEqual(result.exitCode, 0);
  });
});
