import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const OUT = '/home/cone/.slicc/sudo-runs';
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const sha = (text) => createHash('sha256').update(text).digest('hex');

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

async function boot(t) {
  const asked = [];
  const logged = [];
  const warn = console.warn;
  console.warn = (...args) => logged.push(args.join(' '));
  const kernel = await createNodeKernel({
    users: 'enforce',
    approve: (req) => {
      asked.push(req);
      return 'deny';
    },
  });
  t.after(() => {
    console.warn = warn;
    kernel.terminate();
  });
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  await kernel.users.add({ name: 'cone', groups: ['sudo'], umask: 0o022 });
  const root = async (script) => {
    const r = await kernel.run(['bash', '-c', script], { cwd: '/' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const cone = (script, options = {}) =>
    kernel.run(['bash', '-c', script], { cwd: '/home/cone', user: 'cone', ...options });
  const ask = async (script, options) => {
    const n = asked.length;
    const r = await cone(script, options);
    assert.equal(asked.length, n + 1, r.stderr);
    return asked.at(-1);
  };
  const client = await attachKernel(await kernel.connect({ tag: 'agent' }), { locks: null });
  t.after(() => client.close());
  const made = await cone(`mkdir -p ${OUT}`);
  assert.equal(made.status, 0, made.stderr);
  return { kernel, root, cone, ask, client, logged };
}

async function refused(run, code, message) {
  await assert.rejects(run, (err) => {
    assert.equal(err.code, code);
    assert.equal(err.message, message);
    return true;
  });
}

test('a request that went unanswered runs later as root, detached, with its output in files the caller owns', async (t) => {
  const { root, ask, client, logged } = await boot(t);
  const req = await ask('sudo bash -c \'cat; tty; echo "$SUDO_USER $PWD"; id -u; echo oops >&2\'');
  assert.equal(req.stdin, 'none');
  const events = [];
  const traced = await client.trace(`sudo-run:${req.id}`, (batch) => {
    events.push(...batch.events);
  });
  t.after(() => traced.close());
  const run = await client.sudoRun(req, {
    stdout: `${OUT}/a.out`,
    stderr: `${OUT}/a.err`,
    tag: `sudo-run:${req.id}`,
  });
  assert.equal(run.pgid, run.pid);
  assert.deepEqual(await run.ended, { status: 0 });
  assert.equal(await root(`cat ${OUT}/a.out`), 'not a tty\ncone /home/cone\n0\n');
  assert.equal(await root(`cat ${OUT}/a.err`), 'oops\n');
  assert.equal(
    await root(`stat -c '%U %G %a' ${OUT}/a.out ${OUT}/a.err`),
    'cone cone 600\ncone cone 600\n'
  );
  const line = logged.find((l) => l.includes(`REPLAY=${req.id}`));
  assert.equal(
    line,
    `sudo: cone : TTY=unknown ; PWD=/home/cone ; USER=root ; REPLAY=${req.id} ; COMMAND=/usr/bin/bash -c 'cat; tty; echo "$SUDO_USER $PWD"; id -u; echo oops >&2'`
  );
  for (let i = 0; i < 100 && !events.some((e) => e.type === 'exit' && e.pid === run.pid); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const first = events.find((e) => e.type === 'exec' && e.pid === run.pid);
  assert.deepEqual([first.argv, first.uid, first.ppid], [['bash', '-c', req.argv[2]], 0, 1]);
  assert.ok(events.some((e) => e.type === 'exec' && e.argv[0] === 'id' && e.uid === 0));
  assert.ok(events.some((e) => e.type === 'exit' && e.pid === run.pid && e.status === 0));
});

test('the run carries the request’s tags and the caller’s, leads a session of its own, and outlives the client that started it', async (t) => {
  const { kernel, ask, client } = await boot(t);
  await refused(
    kernel.sudoRun({}),
    'EINVAL',
    "sudo: that isn't a sudo request this kernel can run"
  );
  const req = await ask('sudo sleep 60', { tag: 'scoop-x' });
  assert.equal(req.tag, 'scoop-x');
  const exits = [];
  const traced = await client.trace('sudo-run:1', ({ events }) => {
    exits.push(...events.filter((e) => e.type === 'exit'));
  });
  t.after(() => traced.close());
  const port = await kernel.connect({ tag: 'agent' });
  const starter = await attachKernel(port, { locks: null });
  const run = await starter.sudoRun(req, { tag: ['sudo-run:1', 'scoop-x'] });
  await starter.close();
  await assert.rejects(run.ended, { name: 'KernelGoneError' });
  const row = (await client.ps()).find((p) => p.pid === run.pid);
  assert.deepEqual(
    [row.argv, row.uid, row.tty, row.sid, row.pgid, row.tag, row.tags],
    [['sleep', '60'], 0, null, run.pid, run.pid, 'agent', ['agent', 'scoop-x', 'sudo-run:1']]
  );
  await client.kill(-run.pgid, 'SIGTERM');
  for (let i = 0; i < 100 && exits.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(
    exits.map(({ pid, status, signal }) => ({ pid, status, signal })),
    [{ pid: run.pid, status: 143, signal: 'SIGTERM' }]
  );
  const again = await kernel.sudoRun(req, { tag: 'embedder' });
  const own = (await client.ps()).find((p) => p.pid === again.pid);
  assert.deepEqual(own.tags, ['scoop-x', 'embedder']);
  await client.kill(-again.pgid, 'SIGKILL');
  assert.deepEqual(await again.ended, { status: 137, signal: 'SIGKILL' });
});

test('a client bound to a user, a sudo -v request and a request that read a pipe or a file are refused', async (t) => {
  const { kernel, ask, client } = await boot(t);
  const req = await ask('sudo true');
  const bound = await attachKernel(await kernel.connect({ user: 'cone' }), { locks: null });
  t.after(() => bound.close());
  await refused(bound.sudoRun(req), 'EPERM', 'sudo: only a root client may run a sudo request');
  const validate = await ask('sudo -v');
  await refused(client.sudoRun(validate), 'EINVAL', 'sudo: a sudo -v request runs no command');
  const piped = await ask('echo x | sudo cat');
  assert.equal(piped.stdin, 'pipe');
  await refused(
    client.sudoRun(piped),
    'EINVAL',
    'sudo: the request read a pipe, and that input is gone'
  );
  const filed = await ask('sudo cat < /etc/passwd');
  assert.equal(filed.stdin, 'file');
  await refused(
    client.sudoRun(filed),
    'EINVAL',
    'sudo: the request read a file, and that input is gone'
  );
});

test('a user that is gone or has another uid, or may no longer ask, is refused', async (t) => {
  const { kernel, ask, client } = await boot(t);
  const req = await ask('sudo id -un');
  await refused(client.sudoRun({ ...req, uid: 4242 }), 'EPERM', 'sudo: cone is no longer uid 4242');
  await refused(client.sudoRun({ ...req, user: 'ghost' }), 'ENOENT', 'sudo: unknown user ghost');
  await refused(client.sudoRun({ ...req, target: 'ghost' }), 'ENOENT', 'sudo: unknown user ghost');
  await kernel.groups.removeMember('sudo', 'cone');
  await refused(
    client.sudoRun(req),
    'EACCES',
    'sudo: cone may no longer ask to run /usr/bin/id -un as root'
  );
  await kernel.groups.addMember('sudo', 'cone');
  const run = await client.sudoRun(req, { stdout: `${OUT}/id.out` });
  assert.deepEqual(await run.ended, { status: 0 });
});

test('a command that now resolves elsewhere or changed, a directory that moved or is shut, and an argument no longer root-only are refused', async (t) => {
  const { root, cone, ask, client } = await boot(t);
  const write = async (path, text) => {
    const r = await cone(`printf %s ${quote(text)} > ${path} && chmod 755 ${path}`);
    assert.equal(r.status, 0, r.stderr);
  };
  await write('/home/cone/a.sh', '#!/bin/bash\necho a\n');
  await write('/home/cone/b.sh', '#!/bin/bash\necho b\n');
  await cone('ln -s a.sh t.sh && mkdir work');
  const linked = await ask('sudo ./t.sh');
  assert.equal(linked.path, '/home/cone/a.sh');
  await cone('ln -sf b.sh t.sh');
  await refused(
    client.sudoRun(linked),
    'EPERM',
    'sudo: ./t.sh now runs /home/cone/b.sh, not /home/cone/a.sh'
  );
  await cone('rm t.sh');
  await refused(client.sudoRun(linked), 'ENOENT', 'sudo: ./t.sh: command not found');
  const script = await ask('sudo ./a.sh');
  assert.deepEqual(script.userWritable, [
    { path: '/home/cone/a.sh', sha256: sha('#!/bin/bash\necho a\n') },
  ]);
  await write('/home/cone/a.sh', '#!/bin/bash\necho swapped\n');
  await refused(
    client.sudoRun(script),
    'EPERM',
    'sudo: /home/cone/a.sh changed since it was requested'
  );
  const inWork = await ask('sudo true', { cwd: '/home/cone/work' });
  await cone('chmod 0 work');
  await refused(
    client.sudoRun(inWork),
    'EACCES',
    "sudo: cannot run in /home/cone/work: it isn't a directory cone can enter"
  );
  await cone('chmod 755 work && mv work old && ln -s old work');
  await refused(
    client.sudoRun(inWork),
    'EACCES',
    'sudo: /home/cone/work changed since it was requested'
  );
  await root('mkdir -p /srv/data && echo hi > /srv/data/f');
  const reading = await ask('sudo cat /srv/data/f');
  assert.equal(reading.rootOnly['/srv/data/f'], true);
  await root('chown cone /srv/data');
  await refused(client.sudoRun(reading), 'EPERM', 'sudo: /srv/data/f is no longer root-only');
});

test('output goes only where the caller may write, and the same file for both is opened once', async (t) => {
  const { root, ask, client } = await boot(t);
  const req = await ask("sudo bash -c 'echo out; echo err >&2'");
  await refused(
    client.sudoRun(req, { stdout: '/root/x.out' }),
    'EACCES',
    'sudo: /root/x.out: Permission denied'
  );
  await refused(
    client.sudoRun(req, { stderr: 'x.err' }),
    'EINVAL',
    'sudo: x.err is not an absolute path'
  );
  await refused(
    client.sudoRun(req, { stdout: '/home/cone/none/x.out' }),
    'ENOENT',
    'sudo: /home/cone/none/x.out: No such file or directory'
  );
  await root(`echo stale > ${OUT}/both && chmod 640 ${OUT}/both && chown cone ${OUT}/both`);
  const run = await client.sudoRun(req, { stdout: `${OUT}/both`, stderr: `${OUT}/both` });
  assert.deepEqual(await run.ended, { status: 0 });
  assert.equal(await root(`cat ${OUT}/both; stat -c '%U %a' ${OUT}/both`), 'out\nerr\ncone 640\n');
});

test('a client of a kernel before protocol 1.16 refuses sudoRun without sending it', async () => {
  const { port1, port2 } = new MessageChannel();
  const sent = [];
  port2.onmessage = ({ data }) => {
    if (data.hello) port2.postMessage({ hello: { protocol: [1, 15] } });
    else sent.push(data.op);
  };
  const old = await attachKernel(port1, { locks: null });
  await assert.rejects(old.sudoRun({ id: 'x' }), { code: 'ENOSYS' });
  assert.deepEqual(sent, []);
  port1.close();
  port2.close();
});
