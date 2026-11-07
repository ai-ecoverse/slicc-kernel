import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const TIMEOUT = { timeout: 120_000 };
const OLD_GROUP = 'root:x:0:\nsudo:x:27:\nusers:x:100:\nnogroup:x:65534:\n';

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

function page() {
  const calls = [];
  const hook = {
    kinds: {
      'dev.read': { group: 'dialout', session: false },
      'dev.write': { session: false },
      'dev.list': {},
    },
    handle: async (request) => {
      calls.push([request.kind, request.stamp.uid]);
      return 'ok';
    },
  };
  return { hook, calls };
}

async function boot(t, options = {}) {
  const denials = [];
  const kernel = await createNodeKernel({
    users: 'enforce',
    approve: () => 'once',
    onDenial: (d) => denials.push(d),
    ...options,
  });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  return { kernel, denials };
}

const ask = (kind) =>
  `exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"${kind}"}' >&3; cat <&3; echo " status $?"`;
const OK = 'ok status 0\n';

async function asks(run) {
  const out = {};
  for (const kind of ['dev.read', 'dev.write', 'dev.list']) {
    const r = await run(ask(kind));
    if (r.stdout === OK) out[kind] = 'ok';
    else {
      assert.match(r.stdout, / status 1\n$/, `${kind}: ${JSON.stringify(r)}`);
      assert.match(
        r.stderr,
        new RegExp(`${kind.replace('.', '\\.')} is not allowed for this user`)
      );
      out[kind] = 'EACCES';
    }
  }
  return out;
}

const ALL = { 'dev.read': 'ok', 'dev.write': 'ok', 'dev.list': 'ok' };
const NONE_BUT_LIST = { 'dev.read': 'EACCES', 'dev.write': 'EACCES', 'dev.list': 'ok' };
const READER = { 'dev.read': 'ok', 'dev.write': 'EACCES', 'dev.list': 'ok' };

test(
  "session: false: the session user outside dialout is EACCES and reported, a dialout member's next client reads but can't write, sudo passes both, sudo -u someone else passes neither",
  TIMEOUT,
  async (t) => {
    const { hook, calls } = page();
    const { kernel, denials } = await boot(t, { requests: hook });
    await kernel.users.add({ name: 'cone', groups: ['sudo'] });
    await kernel.users.add({ name: 'carol' });
    await kernel.run(
      [
        'bash',
        '-c',
        "printf 'NOPASSWD cone Cmnd *\\n' > /etc/sudoers.d/cone && chmod 440 /etc/sudoers.d/cone",
      ],
      { cwd: '/' }
    );
    const as = (user) => (script) => kernel.run(['bash', '-c', script], { cwd: '/tmp', user });
    assert.deepEqual(await asks(as('cone')), NONE_BUT_LIST);
    assert.deepEqual(
      denials.map(({ pid, ...d }) => [typeof pid, d]),
      ['dev.read', 'dev.write'].map((kind) => [
        'number',
        { uid: 1000, op: 'embedder', path: '/dev/embedder', errno: 'EACCES', kind },
      ])
    );
    const early = await attachKernel(await kernel.connect({ user: 'cone', requests: hook }));
    t.after(() => early.close?.());
    await kernel.groups.addMember('dialout', 'cone');
    assert.deepEqual(await asks(as('cone')), READER);
    const late = await attachKernel(await kernel.connect({ user: 'cone', requests: hook }));
    t.after(() => late.close?.());
    const on = (client) => (script) => client.run(['bash', '-c', script], { cwd: '/tmp' });
    assert.deepEqual(await asks(on(late)), READER);
    assert.deepEqual(await asks(on(early)), NONE_BUT_LIST);
    const sudo = (script) =>
      kernel.run(['sudo', 'bash', '-c', script], { cwd: '/tmp', user: 'cone' });
    assert.deepEqual(await asks(sudo), ALL);
    const carol = (script) =>
      kernel.run(['sudo', '-u', 'carol', 'bash', '-c', script], { cwd: '/tmp' });
    assert.deepEqual(await asks(carol), {
      'dev.read': 'EACCES',
      'dev.write': 'EACCES',
      'dev.list': 'EACCES',
    });
    assert.deepEqual(await asks(as(undefined)), ALL);
    assert.deepEqual(
      calls.filter(([kind]) => kind !== 'dev.list'),
      [
        ['dev.read', 1000],
        ['dev.read', 1000],
        ['dev.read', 0],
        ['dev.write', 0],
        ['dev.read', 0],
        ['dev.write', 0],
      ]
    );
    assert.deepEqual(
      denials.map((d) => `${d.uid} ${d.kind}`),
      [
        '1000 dev.read',
        '1000 dev.write',
        '1000 dev.write',
        '1000 dev.write',
        '1000 dev.read',
        '1000 dev.write',
        '1001 dev.read',
        '1001 dev.write',
        '1001 dev.list',
      ]
    );
  }
);

test("with users: 'off' no kind is checked and nothing is reported", TIMEOUT, async (t) => {
  const { hook, calls } = page();
  const { kernel, denials } = await boot(t, { users: 'off', requests: hook });
  await kernel.users.add({ name: 'bob' });
  const bob = (script) => kernel.run(['bash', '-c', script], { cwd: '/tmp', user: 'bob' });
  assert.deepEqual(await asks(bob), ALL);
  assert.equal(calls.length, 3);
  assert.deepEqual(denials, []);
});

test(
  'groups.add: dialout is in a fresh /etc/group, an /etc/group written without it gets it at gid 20, a known name is kept, a taken gid is EEXIST and a bad name EINVAL; a member it gains passes the dialout kind',
  TIMEOUT,
  async (t) => {
    const { hook } = page();
    const { kernel } = await boot(t, { requests: hook });
    const etc = async () => new TextDecoder().decode(await kernel.readFile('/etc/group'));
    assert.match(await etc(), /^dialout:x:20:$/m);
    assert.deepEqual(await kernel.groups.add('dialout', { gid: 20 }), {
      name: 'dialout',
      gid: 20,
      members: [],
    });
    await kernel.writeFile('/etc/group', OLD_GROUP);
    await kernel.users.add({ name: 'cone' });
    const cone = (script) => kernel.run(['bash', '-c', script], { cwd: '/tmp', user: 'cone' });
    await assert.rejects(kernel.groups.addMember('dialout', 'cone'), /ENOENT|no group dialout/);
    assert.deepEqual(await kernel.groups.add('dialout', { gid: 20 }), {
      name: 'dialout',
      gid: 20,
      members: [],
    });
    assert.deepEqual(await kernel.groups.add('dialout', { gid: 21 }), {
      name: 'dialout',
      gid: 20,
      members: [],
    });
    await assert.rejects(kernel.groups.add('wheel', { gid: 27 }), (e) => e.code === 'EEXIST');
    await assert.rejects(kernel.groups.add('Not Ok', { gid: 30 }), (e) => e.code === 'EINVAL');
    await assert.rejects(kernel.groups.add('plugdev', { gid: -5 }), (e) => e.code === 'EINVAL');
    assert.deepEqual(await asks(cone), NONE_BUT_LIST);
    await kernel.groups.addMember('dialout', 'cone');
    assert.deepEqual(await asks(cone), READER);
    const text = await etc();
    assert.match(text, /^dialout:x:20:cone$/m);
    assert.equal(text.match(/^dialout:/gm).length, 1);
    assert.deepEqual(
      (await kernel.groups.list()).map((g) => g.name),
      ['root', 'sudo', 'users', 'nogroup', 'cone', 'dialout']
    );
  }
);
