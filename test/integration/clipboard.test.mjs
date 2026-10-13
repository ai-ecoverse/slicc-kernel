import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = fileURLToPath(new URL('fixtures/cliptest/', import.meta.url));

async function installDir(kernel, dir, at, only = () => true) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    if (!only(relative(dir, file))) continue;
    await kernel.writeFile(`${at}/${relative(dir, file)}`, await readFile(file));
  }
}

function fakeClipboard(text = '') {
  const calls = [];
  const state = { text, mode: 'ok' };
  const refusal = () =>
    Object.assign(new Error("The clipboard needs seven's tab to be in front"), {
      name: 'NotAllowedError',
    });
  const answer = () => {
    if (state.mode === 'refuse') throw refusal();
    if (state.mode === 'fail') throw new Error('the clipboard broke');
    if (state.mode === 'hang') return new Promise(() => {});
  };
  const hook = {
    read: async (stamp) => {
      calls.push({ op: 'read', stamp });
      await answer();
      return state.text;
    },
    write: async (written, stamp) => {
      calls.push({ op: 'write', text: written, stamp });
      await answer();
      state.text = written;
    },
  };
  return { calls, state, hook, writes: () => calls.filter((c) => c.op === 'write') };
}

async function booted(t, options = {}) {
  const kernel = await createNodeKernel(options);
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) {
    await installDir(
      kernel,
      fileURLToPath(new URL(`${name}/`, modules)),
      `/node_modules/@ai-ecoverse/${name}`
    );
  }
  await installDir(kernel, fixture, '/node_modules/cliptest', (name) =>
    /^(bin\/|package\.json$)/.test(name)
  );
  const bash = (script, o = {}) => kernel.run(['bash', '-c', script], { cwd: '/tmp', ...o });
  return { kernel, bash };
}

async function until(check) {
  for (let i = 0; i < 200; i++) {
    const got = check();
    if (got) return got;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting');
}

test('/dev/clipboard round-trips text through bash and cat, and stats as a char device', async (t) => {
  const clip = fakeClipboard('from the page\n');
  const { bash } = await booted(t, { clipboard: clip.hook });
  assert.deepEqual(await bash('cat /dev/clipboard'), {
    status: 0,
    stdout: 'from the page\n',
    stderr: '',
  });
  const copied = await bash('printf \'h\\303\\251llo\\n\' | cat > /dev/clipboard; echo "rc=$?"');
  assert.deepEqual(copied, { status: 0, stdout: 'rc=0\n', stderr: '' });
  assert.deepEqual(
    clip.writes().map((c) => c.text),
    ['héllo\n']
  );
  assert.equal((await bash('cat /dev/clipboard')).stdout, 'héllo\n');
  assert.equal(
    (await bash("stat -c '%F %a' /dev/clipboard")).stdout,
    'character special file 666\n'
  );
  assert.ok((await bash('ls /dev')).stdout.split('\n').includes('clipboard'));
  assert.equal((await bash(': > /dev/clipboard; cat /dev/clipboard | wc -c')).stdout, '0\n');
  assert.equal(clip.writes().at(-1).text, '');
  assert.equal(clip.state.text, '');
});

test('the hook refusing, failing or missing reaches cat as EACCES, EIO and ENOTSUP', async (t) => {
  const clip = fakeClipboard('x');
  const { bash } = await booted(t, { clipboard: clip.hook });
  clip.state.mode = 'refuse';
  const copy = await bash('printf x | cat > /dev/clipboard; echo "rc=$?"');
  assert.equal(copy.stdout, 'rc=1\n');
  assert.equal(copy.stderr, 'cat: write error: Permission denied\n');
  const paste = await bash('cat /dev/clipboard; echo "rc=$?"');
  assert.equal(paste.stdout, 'rc=1\n');
  assert.equal(paste.stderr, 'cat: /dev/clipboard: Permission denied\n');
  clip.state.mode = 'fail';
  const broken = await bash('printf x | cat > /dev/clipboard; echo "rc=$?"');
  assert.equal(broken.stdout, 'rc=1\n');
  assert.equal(broken.stderr, 'cat: write error: I/O error\n');

  const bare = await booted(t);
  const none = await bare.bash(
    'cat /dev/clipboard; echo "read=$?"; printf x | cat > /dev/clipboard; echo "write=$?"'
  );
  assert.equal(none.stdout, 'read=1\nwrite=1\n');
  assert.equal(
    none.stderr,
    'cat: /dev/clipboard: Not supported\ncat: write error: Not supported\n'
  );
});

test('/dev/clipboard refuses more than 1 MiB with EFBIG and invalid UTF-8 with EILSEQ, without a hook call', async (t) => {
  const clip = fakeClipboard();
  const { bash } = await booted(t, { clipboard: clip.hook });
  const big = await bash('head -c 1048577 /dev/zero | cat > /dev/clipboard; echo "rc=$?"');
  assert.equal(big.stdout, 'rc=1\n');
  assert.equal(big.stderr, 'cat: write error: File too large\n');
  const bad = await bash('printf \'\\377\' | cat > /dev/clipboard; echo "rc=$?"');
  assert.equal(bad.stdout, 'rc=1\n');
  assert.equal(bad.stderr, 'cat: write error: Illegal byte sequence\n');
  assert.deepEqual(clip.writes(), []);
  const full = await bash(
    'head -c 1048576 /dev/zero | tr "\\0" a | cat > /dev/clipboard; echo "rc=$?"'
  );
  assert.equal(full.stdout, 'rc=0\n', full.stderr);
  assert.equal(clip.writes()[0].text.length, 1048576);
});

test('dup and fork share one buffer, committed once at the last close', async (t) => {
  const clip = fakeClipboard();
  const { bash } = await booted(t, { clipboard: clip.hook });
  const script =
    'exec 3>/dev/clipboard; echo a >&3; (echo b >&3); exec 4>&3; echo c >&4; exec 3>&-; echo "open"; exec 4>&-';
  const r = await bash(script);
  assert.equal(r.stdout, 'open\n', r.stderr);
  assert.deepEqual(
    clip.writes().map((c) => c.text),
    ['a\nb\nc\n']
  );
});

test('a hook that never answers times out with EIO after 10 s', async (t) => {
  const clip = fakeClipboard();
  const { bash } = await booted(t, { clipboard: clip.hook });
  clip.state.mode = 'hang';
  const began = Date.now();
  const r = await bash('cat /dev/clipboard; echo "rc=$?"');
  assert.equal(r.stdout, 'rc=1\n');
  assert.equal(r.stderr, 'cat: /dev/clipboard: I/O error\n');
  assert.ok(Date.now() - began >= 9500);
});

test('WASI programs read and write /dev/clipboard through std::fs, and an exit without close commits', async (t) => {
  const clip = fakeClipboard('page text');
  const { kernel, bash } = await booted(t, { clipboard: clip.hook, users: 'enforce' });
  await kernel.users.add({ name: 'cone', groups: ['sudo'] });
  const cone = (await kernel.users.list()).find((u) => u.name === 'cone');
  assert.deepEqual(await kernel.run(['cliptest', 'paste']), {
    status: 0,
    stdout: 'page text',
    stderr: '',
  });
  assert.equal((await kernel.run(['cliptest', 'write', 'wasi ✓'])).status, 0);
  assert.equal(clip.state.text, 'wasi ✓');
  assert.deepEqual(await kernel.run(['cliptest', 'both']), {
    status: 0,
    stdout: 'wasi ✓',
    stderr: '',
  });
  assert.equal(clip.writes().length, 1);
  assert.equal((await kernel.run(['cliptest', 'both', 'swapped'])).stdout, 'wasi ✓');
  assert.equal((await kernel.run(['cliptest', 'seek'])).stdout, 'seek: 70\n');
  assert.equal(clip.state.text, 'swapped');

  clip.state.mode = 'refuse';
  const refused = await kernel.run(['cliptest', 'copy', 'no']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cliptest: close: .*(Permission denied|EACCES|denied)/i);
  clip.state.mode = 'ok';

  const before = clip.writes().length;
  const left = await kernel.run(['cliptest', 'leak', 'left open'], {
    user: 'cone',
    cwd: '/home/cone',
  });
  assert.equal(left.status, 0, left.stderr);
  const leaked = await until(() => clip.writes().slice(before)[0]);
  assert.equal(leaked.text, 'left open');
  assert.equal(leaked.stamp.uid, cone.uid);
  assert.equal(leaked.stamp.users, 'enforce');
  assert.equal(typeof leaked.stamp.pid, 'number');
  assert.equal((await bash('cat /dev/clipboard')).stdout, 'left open');
});

test('JS programs use /dev/clipboard through ctx.fs and ctx.open, with the hook message', async (t) => {
  const clip = fakeClipboard('js in');
  const { kernel } = await booted(t, { clipboard: clip.hook });
  assert.deepEqual(await kernel.run(['clipjs', 'paste']), {
    status: 0,
    stdout: 'js in',
    stderr: '',
  });
  assert.equal((await kernel.run(['clipjs', 'copy', 'js out'])).status, 0);
  assert.equal(clip.state.text, 'js out');
  assert.equal((await kernel.run(['clipjs', 'pieces', 'a,b,c'])).status, 0);
  assert.deepEqual(
    clip.writes().map((c) => c.text),
    ['js out', 'abc']
  );
  assert.equal((await kernel.run(['clipjs', 'stat'])).stdout, '20000 666 true\n');
  clip.state.mode = 'refuse';
  const refused = await kernel.run(['clipjs', 'copy', 'no']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /EACCES .*The clipboard needs seven's tab to be in front/);
  const unread = await kernel.run(['clipjs', 'paste']);
  assert.match(unread.stderr, /EACCES .*The clipboard needs seven's tab to be in front/);
});

test('the stamp carries the effective ids, the users mode and the tag (users: enforce)', async (t) => {
  const clip = fakeClipboard('s');
  const { kernel, bash } = await booted(t, { clipboard: clip.hook, users: 'enforce' });
  await kernel.users.add({ name: 'cone', groups: ['sudo'] });
  await kernel.users.add({ name: 'scoop' });
  const ids = Object.fromEntries((await kernel.users.list()).map((u) => [u.name, u]));
  await bash('printf c | cat > /dev/clipboard', { user: 'cone', cwd: '/home/cone' });
  await bash('cat /dev/clipboard', { user: 'scoop', cwd: '/home/scoop', tag: 'agent' });
  const [write, read] = clip.calls;
  assert.equal(write.op, 'write');
  assert.equal(write.stamp.uid, ids.cone.uid);
  assert.equal(write.stamp.gid, ids.cone.gid);
  assert.equal(write.stamp.users, 'enforce');
  assert.equal('tag' in write.stamp, false);
  assert.equal(read.op, 'read');
  assert.equal(read.stamp.uid, ids.scoop.uid);
  assert.equal(read.stamp.tag, 'agent');
  assert.ok(read.stamp.pid > 0);
});

test('the stamp carries the inherited tag of terminals and clients (users: off)', async (t) => {
  const clip = fakeClipboard('t');
  const { kernel, bash } = await booted(t, { clipboard: clip.hook });
  const term = await kernel.openTerminal(
    ['bash', '-c', 'printf u | cat > /dev/clipboard; (cat /dev/clipboard > /dev/null)'],
    { tag: 'user', cwd: '/tmp' }
  );
  await term.exited;
  const client = await attachKernel(await kernel.connect({ tag: 'agent' }));
  t.after(() => client.close());
  await client.run(['bash', '-c', 'printf a | cat > /dev/clipboard'], { cwd: '/tmp' });
  await bash('cat /dev/clipboard > /dev/null');
  assert.deepEqual(
    clip.calls.map((c) => [c.op, c.stamp.tag]),
    [
      ['write', 'user'],
      ['read', 'user'],
      ['write', 'agent'],
      ['read', undefined],
    ]
  );
  assert.equal(clip.calls[0].stamp.users, 'off');
});
