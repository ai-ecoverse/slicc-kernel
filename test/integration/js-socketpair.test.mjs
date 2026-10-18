import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const dec = 'const dec = new TextDecoder();';

const CHILD = `${dec}
export default async function main(ctx) {
  const st = await ctx.fdStatus(3);
  const got = dec.decode(await ctx.read(3));
  await ctx.write(3, 'pong:' + got + ':' + st.type);
  if (ctx.argv[1] === 'grand') {
    const g = await ctx.spawn({ argv: ['ipcprobe'] });
    await g.wait();
  }
}
`;

const PROBE = `export default async function main(ctx) {
  try {
    await ctx.fdStatus(3);
    await ctx.write(1, 'probe has fd 3\\n');
  } catch (e) {
    await ctx.write(1, 'probe ' + e.code + '\\n');
  }
}
`;

const PARENT = `${dec}
export default async function main(ctx) {
  const say = (s) => ctx.write(1, s + '\\n');
  const mode = ctx.argv[1];
  if (mode === 'basic') {
    const [a, b] = await ctx.socketpair();
    const child = await ctx.spawn({ argv: ['ipcchild', 'grand'], fds: { 3: b } });
    await ctx.close(b);
    const reading = ctx.read(a);
    await ctx.write(a, 'ping');
    await say(dec.decode(await reading));
    await say('exit ' + (await child.wait()).status);
    await say('eof ' + (await ctx.read(a)).length);
    const later = await ctx.spawn({ argv: ['ipcprobe'] });
    await later.wait();
    await ctx.signals.ignore('SIGPIPE');
    try {
      await ctx.write(a, 'more');
      await say('wrote');
    } catch (e) {
      await say('write ' + e.code);
    }
    await ctx.close(a);
  } else if (mode === 'sigpipe') {
    const [a, b] = await ctx.socketpair();
    await ctx.close(b);
    try {
      await ctx.write(a, 'x');
      await say('wrote');
    } catch (e) {
      await say('write ' + e.code);
    }
  } else if (mode === 'pending') {
    const [a] = await ctx.socketpair();
    const reading = ctx.read(a).then((r) => 'eof ' + r.length, (e) => e.code);
    await new Promise((r) => setTimeout(r, 50));
    await ctx.close(a);
    await say('pending ' + (await reading));
    const [c] = await ctx.socketpair();
    const syncReading = ctx.read(c).then((r) => 'eof ' + r.length, (e) => e.code);
    await new Promise((r) => setTimeout(r, 50));
    ctx.sync.close(c);
    await say('sync close ' + (await syncReading));
  } else if (mode === 'sync') {
    const [a, b] = ctx.sync.socketpair();
    const child = ctx.sync.spawn({ argv: ['ipcchild'], fds: { 3: b } });
    ctx.sync.close(b);
    ctx.sync.write(a, 'sping');
    await say(dec.decode(ctx.sync.read(a)));
    await child.wait();
    await say('eof ' + ctx.sync.read(a).length);
    ctx.sync.close(a);
    const [r, w] = ctx.sync.pipe();
    ctx.sync.write(w, 'piped');
    ctx.sync.close(w);
    await say(dec.decode(ctx.sync.read(r)) + ' ' + ctx.sync.read(r).length);
    const [ar, aw] = await ctx.pipe();
    await ctx.write(aw, 'apipe');
    await ctx.close(aw);
    await say(dec.decode(await ctx.read(ar)));
  } else if (mode === 'bad') {
    const [a, b] = await ctx.socketpair();
    for (const fds of [{ 2: b }, { 3: -1 }, { x: b }, { 3: 1.5 }, [b], null, { '03': b }]) {
      try {
        await ctx.spawn({ argv: ['ipcchild'], fds });
        await say('spawned');
      } catch (e) {
        await say(e.code);
      }
    }
    try {
      ctx.sync.spawn({ argv: ['ipcchild'], fds: { 1: a } });
    } catch (e) {
      await say('sync ' + e.code);
    }
  }
}
`;

async function program(kernel, name, source) {
  await kernel.writeFile(
    `/node_modules/${name}/package.json`,
    JSON.stringify({ name, slicc: { commands: { [name]: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile(`/node_modules/${name}/main.mjs`, source);
}

async function booted(t) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  await program(kernel, 'ipcparent', PARENT);
  await program(kernel, 'ipcchild', CHILD);
  await program(kernel, 'ipcprobe', PROBE);
  return (mode) => kernel.run(['ipcparent', mode], { cwd: '/' });
}

test('ctx.socketpair and spawn fds: a child gets its end at fd 3 as a socket, messages go both ways, its exit is EOF, and only named fds reach a child (#1093)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('basic'), {
    status: 0,
    stdout: 'pong:ping:socket\nprobe EBADF\nexit 0\neof 0\nprobe EBADF\nwrite EPIPE\n',
    stderr: '',
  });
});

test('a write to a socket whose peer closed fails with EPIPE and raises no SIGPIPE, as if MSG_NOSIGNAL were set, at the default disposition too (#1093)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('sigpipe'), { status: 0, stdout: 'write EPIPE\n', stderr: '' });
});

test('a read pending on a socket fd resolves when the fd is closed, by ctx.close or ctx.sync.close (#1093)', async (t) => {
  const run = await booted(t);
  const r = await run('pending');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^pending (eof 0|EBADF)\nsync close (eof 0|EBADF)\n$/);
});

test('ctx.sync.socketpair, ctx.sync.spawn with fds, and ctx.pipe / ctx.sync.pipe (#1093)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('sync'), {
    status: 0,
    stdout: 'pong:sping:socket\neof 0\npiped 0\napipe\n',
    stderr: '',
  });
});

test('spawn fds refuses stdio numbers, non-integers, negative fds and non-objects with EINVAL (#1093)', async (t) => {
  const run = await booted(t);
  assert.deepEqual(await run('bad'), {
    status: 0,
    stdout: 'EINVAL\nEINVAL\nEINVAL\nEINVAL\nEINVAL\nEINVAL\nEINVAL\nsync EINVAL\n',
    stderr: '',
  });
});
