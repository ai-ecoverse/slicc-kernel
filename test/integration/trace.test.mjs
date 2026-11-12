import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

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

async function booted(t, options = {}) {
  const kernel = await createNodeKernel({ users: 'enforce', ...options });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  const client = await attachKernel(await kernel.connect({ tag: 'agent' }));
  t.after(() => client.close());
  return { kernel, client };
}

function recorder() {
  const events = [];
  let dropped = 0;
  const waiters = [];
  const onEvents = (batch) => {
    events.push(...batch.events);
    dropped += batch.dropped;
    for (const w of [...waiters]) {
      if (!w.until(events)) continue;
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve();
    }
  };
  const until = (predicate) =>
    predicate(events)
      ? Promise.resolve()
      : new Promise((resolve) => waiters.push({ until: predicate, resolve }));
  return {
    events,
    get dropped() {
      return dropped;
    },
    onEvents,
    until,
  };
}

const exitOf = (pid) => (events) => events.some((e) => e.type === 'exit' && e.pid === pid);

function ordered(events) {
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].seq > events[i - 1].seq, `seq ${events[i].seq} after ${events[i - 1].seq}`);
  }
  const ended = new Set();
  for (const e of events) {
    assert.ok(!ended.has(e.pid), `an event for pid ${e.pid} after its exit`);
    if (e.type === 'exit') ended.add(e.pid);
  }
}

const ACCEPTANCE =
  'cd /tmp; for i in 1 2; do printf x; done; seq 3 | sed s/1/x/ | head -1; timeout 5 true 2>&1; node -e "1"';

test('a trace on a tag reports every program a bash -c ran, with its exe and exit status, and nothing for builtins, keywords or the forks that run them', async (t) => {
  const { kernel, client } = await booted(t);
  await install(kernel, 'wasm-sed');
  await kernel.writeFile(
    '/node_modules/fakenode/package.json',
    JSON.stringify({
      name: 'fakenode',
      slicc: { commands: { node: { abi: 'js', module: 'node.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/fakenode/node.mjs', 'export default async () => 0;\n');
  const seen = recorder();
  const trace = await client.trace('call-1', seen.onEvents);
  t.after(() => trace.close());
  const other = recorder();
  const elsewhere = await client.trace('call-2', other.onEvents);
  t.after(() => elsewhere.close());
  const run = await client.run(['bash', '-c', ACCEPTANCE], { tag: 'call-1', cwd: '/tmp' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'xxx\n', run.stderr);
  await seen.until(exitOf(run.pid));
  const { events } = seen;
  ordered(events);
  const execs = events.filter((e) => e.type === 'exec');
  assert.deepEqual(execs.map((e) => e.argv[0]).sort(), [
    'bash',
    'head',
    'node',
    'sed',
    'seq',
    'timeout',
    'true',
  ]);
  assert.equal(execs[0].argv[0], 'bash');
  for (const name of ['cd', 'for', 'printf', '1', 'do', 'done']) {
    assert.ok(!execs.some((e) => e.argv[0] === name), `${name} has no exec`);
  }
  const named = (name) => execs.find((e) => e.argv[0] === name);
  assert.deepEqual(named('bash').argv, ['bash', '-c', ACCEPTANCE]);
  assert.equal(named('bash').pid, run.pid);
  assert.equal(named('bash').ppid, 1);
  assert.deepEqual(named('sed').argv, ['sed', 's/1/x/']);
  assert.deepEqual(named('timeout').argv, ['timeout', '5', 'true']);
  assert.equal(named('true').ppid, named('timeout').pid, 'timeout runs true as its child');
  assert.match(named('seq').exe, /wasm-coreutils/);
  assert.match(named('sed').exe, /wasm-sed/);
  assert.equal(named('node').exe, '/node_modules/fakenode/node.mjs');
  for (const e of execs) {
    assert.equal(typeof e.at, 'number');
    assert.equal(e.uid, 0);
    assert.equal(e.pgid, run.pid);
  }
  const exit = (pid) => events.find((e) => e.type === 'exit' && e.pid === pid);
  for (const name of ['seq', 'sed', 'head', 'timeout', 'true', 'node']) {
    const e = exit(named(name).pid);
    assert.ok(e, `${name} exits`);
    assert.equal(typeof e.status, 'number');
    assert.ok(e.at >= named(name).at);
  }
  for (const name of ['sed', 'head', 'timeout', 'true', 'node']) {
    assert.equal(exit(named(name).pid).status, 0, name);
  }
  assert.equal(typeof exit(named('seq').pid).utime, 'number');
  const forks = events.filter((e) => e.type === 'fork');
  assert.ok(forks.length >= 3, 'the pipeline children are forks of bash');
  for (const f of forks) {
    assert.equal(f.argv[0], 'bash');
    assert.equal(f.ppid, run.pid);
  }
  const execed = new Set(execs.map((e) => e.pid));
  const forkedOnly = forks.filter((f) => !execed.has(f.pid));
  for (const f of forkedOnly) assert.ok(exit(f.pid), 'a fork that runs no program exits too');
  assert.equal(
    exit(run.pid).seq,
    Math.max(...events.map((e) => e.seq)),
    'the whole call ends last, as node, which bash ran in its own place'
  );
  assert.equal(named('node').pid, run.pid, 'bash runs its last command in its own place');
  assert.equal(named('node').replaced, true);
  assert.equal(named('bash').replaced, undefined);
  assert.deepEqual(other.events, [], 'a trace on another tag sees none of it');
});

test('a spawn may add several tags, and a trace on any of them sees its tree; against a 1.14 kernel several tags and a trace reject with ENOSYS before sending anything', async (t) => {
  const { client } = await booted(t);
  const seen = recorder();
  const trace = await client.trace('call-3', seen.onEvents);
  t.after(() => trace.close());
  const child = await client.spawn(['sleep', '5'], { tag: ['taint', 'call-3'], cwd: '/tmp' });
  const row = (await client.ps()).find((p) => p.pid === child.pid);
  assert.deepEqual(row?.tags, ['agent', 'taint', 'call-3']);
  await child.signal('SIGKILL');
  await seen.until(exitOf(child.pid));
  assert.deepEqual(
    seen.events.map((e) => [e.type, e.pid, e.argv?.[0], e.signal]),
    [
      ['exec', child.pid, 'sleep', undefined],
      ['exit', child.pid, undefined, 'SIGKILL'],
    ]
  );
  await assert.rejects(client.run(['true'], { tag: ['a', 3], cwd: '/tmp' }), /tag/);
  await assert.rejects(
    client.trace('', () => {}),
    { code: 'EINVAL' }
  );
  await assert.rejects(
    client.trace('x', () => {}, { limit: 0 }),
    { code: 'EINVAL' }
  );

  const { port1, port2 } = new MessageChannel();
  const sent = [];
  port2.onmessage = ({ data }) => {
    if (data.hello) port2.postMessage({ hello: { protocol: [1, 14] } });
    else sent.push(data.op);
  };
  const old = await attachKernel(port1, { locks: null });
  try {
    await assert.rejects(
      old.trace('call', () => {}),
      { code: 'ENOSYS' }
    );
    await assert.rejects(old.spawn(['true'], { tag: ['a', 'b'] }), { code: 'ENOSYS' });
    await assert.rejects(old.openTerminal(['bash'], { tag: ['a', 'b'] }), { code: 'ENOSYS' });
    assert.deepEqual(sent, []);
  } finally {
    old.close();
    port1.close();
    port2.close();
  }
});

test('a process that exits at once is still reported, exec before exit, and a program that cannot start has no exec, only its fork', async (t) => {
  const { client } = await booted(t);
  const seen = recorder();
  const trace = await client.trace('quick', seen.onEvents);
  t.after(() => trace.close());
  const ok = await client.run(['true'], { tag: 'quick', cwd: '/tmp' });
  const no = await client.run(['false'], { tag: 'quick', cwd: '/tmp' });
  const killed = await client.run(['bash', '-c', 'kill -KILL $$'], { tag: 'quick', cwd: '/tmp' });
  const missing = await client.run(['bash', '-c', 'no-such-program; /bin/true'], {
    tag: 'quick',
    cwd: '/tmp',
  });
  assert.equal(missing.status, 0, missing.stderr);
  await seen.until(exitOf(missing.pid));
  ordered(seen.events);
  const of = (pid) => seen.events.filter((e) => e.pid === pid).map((e) => [e.type, e.status]);
  assert.deepEqual(of(ok.pid), [
    ['exec', undefined],
    ['exit', 0],
  ]);
  assert.deepEqual(of(no.pid), [
    ['exec', undefined],
    ['exit', 1],
  ]);
  const death = seen.events.find((e) => e.type === 'exit' && e.pid === killed.pid);
  assert.equal(death.signal, 'SIGKILL');
  const tree = seen.events.filter((e) => e.seq > death.seq);
  assert.deepEqual(
    tree.filter((e) => e.type === 'exec').map((e) => e.argv[0]),
    ['bash', 'true'],
    'no exec for the program that was not found'
  );
  const failed = tree.find((e) => e.type === 'exit' && e.status === 127);
  assert.ok(failed, 'the fork that could not exec exits 127');
  assert.deepEqual(
    tree.filter((e) => e.pid === failed.pid).map((e) => e.type),
    ['fork', 'exit']
  );
});

test('a background job that outlives its parent is reported after the parent has exited', async (t) => {
  const { client } = await booted(t);
  const seen = recorder();
  const trace = await client.trace('bg', seen.onEvents);
  t.after(() => trace.close());
  const run = await client.run(['bash', '-c', 'sleep 0.4 & echo $!'], { tag: 'bg', cwd: '/tmp' });
  const job = Number(run.stdout.trim());
  assert.ok(job > run.pid, run.stderr);
  await seen.until(exitOf(run.pid));
  assert.ok(!exitOf(job)(seen.events), 'the job is still running when bash has exited');
  await seen.until(exitOf(job));
  ordered(seen.events);
  const parent = seen.events.find((e) => e.type === 'exit' && e.pid === run.pid);
  const sleep = seen.events.find((e) => e.type === 'exec' && e.pid === job);
  const ended = seen.events.find((e) => e.type === 'exit' && e.pid === job);
  const forked = seen.events.find((e) => e.type === 'fork' && e.pid === job);
  assert.deepEqual(sleep.argv, ['sleep', '0.4']);
  assert.equal(forked.ppid, run.pid);
  assert.ok(forked.seq < sleep.seq && forked.seq < parent.seq && parent.seq < ended.seq);
  assert.equal(ended.status, 0);
});

test("a client bound to a user sees only that user's tagged processes, as in ps; root sees every one", async (t) => {
  const { kernel } = await booted(t);
  await kernel.users.add({ name: 'cone' });
  await kernel.users.add({ name: 'scoop' });
  const root = await attachKernel(await kernel.connect());
  t.after(() => root.close());
  const cone = await attachKernel(await kernel.connect({ user: 'cone' }));
  t.after(() => cone.close());
  const all = recorder();
  const mine = recorder();
  const traces = [
    await root.trace('shared', all.onEvents),
    await cone.trace('shared', mine.onEvents),
  ];
  t.after(() => {
    for (const trace of traces) trace.close();
  });
  const theirs = await root.run(['bash', '-c', 'seq 1; true'], {
    tag: 'shared',
    user: 'scoop',
    cwd: '/tmp',
  });
  const own = await root.run(['bash', '-c', 'seq 2; true'], {
    tag: 'shared',
    user: 'cone',
    cwd: '/tmp',
  });
  await all.until((events) => exitOf(theirs.pid)(events) && exitOf(own.pid)(events));
  await mine.until(exitOf(own.pid));
  const uid = (await cone.run(['id', '-u'], { cwd: '/tmp' })).stdout.trim();
  const theirsTree = new Set(
    all.events
      .filter((e) => e.seq <= all.events.find((x) => x.type === 'exit' && x.pid === theirs.pid).seq)
      .map((e) => e.pid)
  );
  assert.ok(theirsTree.has(theirs.pid));
  assert.ok(mine.events.some((e) => e.type === 'exec' && e.argv[0] === 'seq'));
  for (const e of mine.events) {
    assert.ok(!theirsTree.has(e.pid), `cone sees none of scoop's pids (${e.pid})`);
    if (e.type !== 'exit') assert.equal(String(e.uid), uid);
  }
  const scoopUid = all.events.find((e) => e.pid === theirs.pid).uid;
  assert.notEqual(String(scoopUid), uid);
  assert.deepEqual(
    all.events.filter((e) => e.type === 'exec').map((e) => e.argv.join(' ')),
    ['bash -c seq 1; true', 'seq 1', 'bash -c seq 2; true', 'seq 2']
  );
});

test('a trace that falls behind keeps at most its limit waiting, drops the rest, and says how many it dropped', async (t) => {
  const { client } = await booted(t);
  const full = recorder();
  const fullTrace = await client.trace('burst', full.onEvents);
  t.after(() => fullTrace.close());
  const kept = [];
  let dropped = 0;
  const gate = Promise.withResolvers();
  let first = true;
  const slow = await client.trace(
    'burst',
    (batch) => {
      kept.push(...batch.events);
      dropped += batch.dropped;
      if (!first) return undefined;
      first = false;
      return gate.promise;
    },
    { limit: 4 }
  );
  t.after(() => slow.close());
  const run = await client.run(['bash', '-c', 'for i in 1 2 3 4 5 6; do /bin/true; done'], {
    tag: 'burst',
    cwd: '/tmp',
  });
  assert.equal(run.status, 0, run.stderr);
  await full.until(exitOf(run.pid));
  const firstBatch = kept.length;
  assert.ok(firstBatch >= 1);
  assert.equal(dropped, 0, 'nothing is counted until the next batch');
  gate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(kept.length, firstBatch + 4, 'the limit waited, the rest was dropped');
  assert.equal(kept.length + dropped, full.events.length, 'every event is either kept or counted');
  assert.ok(dropped > 0);
  ordered(kept);
  const fresh = await client.run(['true'], { tag: 'burst', cwd: '/tmp' });
  await full.until(exitOf(fresh.pid));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(
    kept.slice(-2).map((e) => [e.type, e.pid]),
    [
      ['exec', fresh.pid],
      ['exit', fresh.pid],
    ],
    'it catches up once the consumer does'
  );
  slow.close();
  const after = kept.length;
  await client.run(['true'], { tag: 'burst', cwd: '/tmp' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(kept.length, after, 'a closed trace gets nothing more');
});
