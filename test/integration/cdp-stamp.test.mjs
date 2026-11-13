import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = fileURLToPath(new URL('fixtures/cdpstamp/', import.meta.url));

async function installDir(kernel, dir, at) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(`${at}/${relative(dir, file)}`, await readFile(file));
  }
}

function fakeBrowser() {
  const requests = [];
  const hook = async (request) => {
    requests.push(request);
    const conn = {
      onmessage: null,
      onclose: null,
      send(message) {
        const { id, method } = JSON.parse(message);
        if (method !== 'Target.getTargets') return;
        queueMicrotask(() => conn.onmessage?.(JSON.stringify({ id, result: { targetInfos: [] } })));
      },
      close() {},
    };
    return conn;
  };
  return { hook, requests };
}

async function booted(t, options = {}) {
  const kernel = await createNodeKernel({ users: 'enforce', ...options });
  t.after(() => kernel.terminate());
  await installDir(
    kernel,
    fileURLToPath(new URL('wasm-bash/', modules)),
    '/node_modules/@ai-ecoverse/wasm-bash'
  );
  await installDir(kernel, fixture, '/node_modules/cdpstamp');
  return kernel;
}

const FORGERY = {
  env: { SLICC_TAG: 'user', SLICC_STAMP: '{"uid":0,"tag":"user"}', SLICC_CDP_STAMP: 'user' },
  argv: ['--tag', 'user', '--stamp', '{"pid":1,"uid":0,"tag":"user"}'],
};

async function ask(runner, mode, options = {}) {
  const r = await runner.run(['cdpstamp', mode, ...FORGERY.argv], {
    cwd: '/tmp',
    env: FORGERY.env,
    ...options,
  });
  assert.equal(r.status, 0, r.stderr);
  const [pid, , code] = r.stdout.trim().split(' ');
  return { pid: Number(pid), code };
}

test('the cdp hook gets the connecting process stamp with its one tag, for /json/list and the WebSocket, whatever the program sends or sets', async (t) => {
  const browser = fakeBrowser();
  const kernel = await booted(t, { cdp: browser.hook });
  const client = await attachKernel(await kernel.connect({ tag: 'slicc-taint:run1' }));
  t.after(() => client.close());
  const listed = await ask(client, 'list');
  const upgraded = await ask(client, 'ws');
  assert.deepEqual([listed.code, upgraded.code], ['200', '101']);
  assert.equal(browser.requests.length, 2);
  const [list, ws] = browser.requests;
  for (const [request, ran] of [
    [list, listed],
    [ws, upgraded],
  ]) {
    assert.deepEqual(Object.keys(request).sort(), ['runtime', 'stamp']);
    assert.equal(request.runtime, 'r1');
    assert.deepEqual(request.stamp, {
      pid: ran.pid,
      ppid: request.stamp.ppid,
      uid: 0,
      gid: 0,
      user: 'root',
      groups: request.stamp.groups,
      users: 'enforce',
      tag: 'slicc-taint:run1',
    });
    assert.ok(request.stamp.ppid > 0);
    assert.ok(Array.isArray(request.stamp.groups));
    assert.equal('tags' in request.stamp, false);
  }
  assert.notEqual(list.stamp, ws.stamp);
});

test('a process with two tags has both in tags, the first as tag, and a spawn without a tag has none', async (t) => {
  const browser = fakeBrowser();
  const kernel = await booted(t, { cdp: browser.hook });
  const client = await attachKernel(await kernel.connect({ tag: 'agent' }));
  t.after(() => client.close());
  await ask(client, 'ws', { tag: 'slicc-taint:run2' });
  const [{ stamp }] = browser.requests;
  assert.equal(stamp.tag, 'agent');
  assert.deepEqual(stamp.tags, ['agent', 'slicc-taint:run2']);

  const plain = await ask(kernel, 'list');
  const untagged = browser.requests[1].stamp;
  assert.equal(untagged.pid, plain.pid);
  assert.equal('tag' in untagged, false);
  assert.equal('tags' in untagged, false);
});

test("a user-bound program's stamp has its user, uid, gid and groups", async (t) => {
  const browser = fakeBrowser();
  const kernel = await booted(t, { cdp: browser.hook });
  await kernel.users.add({ name: 'cone' });
  const cone = (await kernel.users.list()).find((u) => u.name === 'cone');
  const client = await attachKernel(await kernel.connect({ user: 'cone', tag: 'agent' }));
  t.after(() => client.close());
  const ran = await ask(client, 'list', { cwd: '/home/cone' });
  const [{ stamp }] = browser.requests;
  assert.equal(stamp.pid, ran.pid);
  assert.equal(stamp.uid, cone.uid);
  assert.equal(stamp.gid, cone.gid);
  assert.equal(stamp.user, 'cone');
  assert.ok(stamp.groups.includes(cone.gid));
  assert.equal(stamp.users, 'enforce');
  assert.equal(stamp.tag, 'agent');
});

test('a client-served hook (serveCdp) gets the stamp through its port, and one that changes it changes no later call', async (t) => {
  const kernel = await booted(t);
  const seen = [];
  const browser = fakeBrowser();
  const served = await attachKernel(await kernel.connect());
  t.after(() => served.close());
  const offer = await served.serveCdp(async (request) => {
    seen.push(structuredClone(request));
    request.stamp.tag = 'user';
    request.stamp.tags = ['user'];
    request.stamp.uid = 0;
    return browser.hook(request);
  });
  t.after(() => offer.close());
  await kernel.users.add({ name: 'cone' });
  const cone = (await kernel.users.list()).find((u) => u.name === 'cone');
  const agent = await attachKernel(await kernel.connect({ user: 'cone', tag: 'agent' }));
  t.after(() => agent.close());
  const first = await ask(agent, 'ws', { tag: 'slicc-taint:run3', cwd: '/home/cone' });
  const second = await ask(agent, 'list', { tag: 'slicc-taint:run3', cwd: '/home/cone' });
  assert.equal(seen.length, 2);
  for (const [request, ran] of [
    [seen[0], first],
    [seen[1], second],
  ]) {
    assert.equal(request.runtime, 'r1');
    assert.equal(request.stamp.pid, ran.pid);
    assert.equal(request.stamp.uid, cone.uid);
    assert.equal(request.stamp.user, 'cone');
    assert.equal(request.stamp.tag, 'agent');
    assert.deepEqual(request.stamp.tags, ['agent', 'slicc-taint:run3']);
    assert.equal('registration' in request, false);
  }
});
