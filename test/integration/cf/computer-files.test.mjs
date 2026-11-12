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

  it('shows a file it creates while the file is still open', async () => {
    const script = [
      'mkdir -p open',
      'exec 3>open/pending.txt',
      'ls open',
      'stat -c %s open/pending.txt',
      'echo hi >&3',
      'set -C',
      '(echo x > open/pending.txt) 2>/dev/null || echo refused',
      'set +C',
      'chmod 600 open/pending.txt',
      'exec 3>&-',
      'cat open/pending.txt',
      ': > open/empty.txt',
      '(umask 077; echo s > open/secret.txt)',
      'mv open/pending.txt open/moved.txt',
    ].join('\n');
    const result = await run(ws, script);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'pending.txt\n0\nrefused\nhi\n');
    assert.equal(await ws.fs.readFile(`${MOUNT}/open/moved.txt`, 'utf8'), 'hi\n');
    assert.equal((await ws.fs.stat(`${MOUNT}/open/moved.txt`)).mode & 0o777, 0o600);
    assert.equal((await ws.fs.stat(`${MOUNT}/open/empty.txt`)).size, 0);
    assert.equal((await ws.fs.stat(`${MOUNT}/open/secret.txt`)).mode & 0o777, 0o600);
    const missing = await run(ws, 'echo x > open/no/such/file');
    assert.notEqual(missing.exitCode, 0);
    assert.match(missing.stderr, /No such file or directory/);
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

describe('closed files committed behind the run', () => {
  let computer;
  let ws;
  const writes = [];
  const counting = (fs) =>
    new Proxy(fs, {
      get(target, key) {
        const value = target[key];
        if (typeof value !== 'function') return value;
        if (key !== 'writeFile' && key !== 'rm') return value.bind(target);
        return async (path, ...rest) => {
          const done = await value.call(target, path, ...rest);
          writes.push(`${key} ${path}`);
          return done;
        };
      },
    });
  before(async () => {
    computer = await computerWith({ wrapFs: counting });
    ws = computer.workspace;
  });
  after(() => computer.close());

  it('lands every file before the result, and a removed temporary file never', async () => {
    writes.length = 0;
    const result = await run(
      ws,
      'mkdir -p wb/d && for i in 1 2 3; do echo $i > wb/f$i; done; echo t > wb/tmp; rm wb/tmp; echo x > wb/d/x; rm -r wb/d; cat wb/f2'
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, '2\n');
    for (const i of [1, 2, 3])
      assert.equal(await ws.fs.readFile(`${MOUNT}/wb/f${i}`, 'utf8'), `${i}\n`);
    await assert.rejects(ws.fs.lstat(`${MOUNT}/wb/tmp`), { code: 'ENOENT' });
    await assert.rejects(ws.fs.lstat(`${MOUNT}/wb/d`), { code: 'ENOENT' });
    assert.ok(!writes.some((entry) => entry.endsWith('/wb/tmp')), writes.join('\n'));
  });

  it('commits a file rewritten many times in one run about once', async () => {
    await ws.fs.mkdir(`${MOUNT}/wb`, { recursive: true });
    await ws.fs.writeFile(`${MOUNT}/wb/again.sh`, 'old', { mode: 0o750 });
    writes.length = 0;
    const result = await run(
      ws,
      'for i in $(seq 1 20); do echo $i > wb/again.sh; echo $i > wb/new.txt; done'
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await ws.fs.readFile(`${MOUNT}/wb/again.sh`, 'utf8'), '20\n');
    assert.equal(await ws.fs.readFile(`${MOUNT}/wb/new.txt`, 'utf8'), '20\n');
    assert.equal((await ws.fs.stat(`${MOUNT}/wb/again.sh`)).mode & 0o777, 0o750);
    const commits = writes.filter((entry) => entry.includes('/wb/')).length;
    assert.ok(commits <= 6, writes.join('\n'));
  });

  it('lands what a background process writes after the run ends', async () => {
    const result = await run(ws, '(sleep 0.3; echo late > wb/late.txt) > /dev/null 2>&1 &');
    assert.equal(result.exitCode, 0);
    const deadline = Date.now() + 5000;
    let text;
    while (Date.now() < deadline && text === undefined) {
      text = await ws.fs.readFile(`${MOUNT}/wb/late.txt`, 'utf8').catch(() => undefined);
      if (text === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(text, 'late\n');
  });
});
