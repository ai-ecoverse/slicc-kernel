import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDev } from './cloudflare-fixture/dev.mjs';

const config = fileURLToPath(
  new URL('../../../examples/cloudflare-computer/wrangler.json', import.meta.url)
);
const remote = { url: process.env.SLICC_CF_COMPUTER_URL, key: process.env.SLICC_CF_COMPUTER_KEY };
const computer = `test-${crypto.randomUUID()}`;
let state;
let dev;

function call(method, path, body, { key = dev.key, query = '' } = {}) {
  const joined = `${path}${path.includes('?') ? '&' : '?'}computer=${computer}${query}`;
  return fetch(`${dev.url}${joined}`, {
    method,
    headers: key ? { authorization: `Bearer ${key}` } : {},
    ...(body === undefined ? {} : { body }),
  });
}

async function json(method, path, body) {
  const response = await call(method, path, body);
  const text = await response.text();
  try {
    return { httpStatus: response.status, ...JSON.parse(text) };
  } catch {
    return { httpStatus: response.status, text };
  }
}

const exec = (source, extra = {}) => json('POST', '/exec', JSON.stringify({ source, ...extra }));
const put = (path, text) => json('PUT', `/file?path=${encodeURIComponent(path)}`, text);

async function read(path) {
  const response = await call('GET', `/file?path=${encodeURIComponent(path)}`);
  return { status: response.status, text: await response.text() };
}

async function streamed(source, extra = {}, onEvent = () => {}) {
  const start = performance.now();
  const response = await call('POST', '/exec', JSON.stringify({ source, stream: true, ...extra }));
  assert.equal(response.status, 200);
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const event = { ...JSON.parse(buffer.slice(0, nl)), at: performance.now() - start };
      buffer = buffer.slice(nl + 1);
      events.push(event);
      await onEvent(event);
      nl = buffer.indexOf('\n');
    }
  }
  return events;
}

async function restartedDev() {
  if (remote.url) return;
  await dev.stop();
  dev = await startDev(config, { persist: join(state, 'state') });
}

before(async () => {
  state = await mkdtemp(join(tmpdir(), 'slicc-cf-computer-'));
  dev = await startDev(config, { remote, persist: join(state, 'state') });
});

after(async () => {
  await dev?.stop?.();
  await rm(state, { recursive: true, force: true });
});

const skipped = (t) => {
  if (!dev?.skip) return false;
  t.skip(dev.skip);
  return true;
};

describe('the Computer example Worker', { concurrency: false }, () => {
  test('every route is behind the key', async (t) => {
    if (skipped(t)) return;
    for (const [method, path] of [
      ['GET', '/boot'],
      ['GET', '/file?path=/workspace/x'],
      ['PUT', '/file?path=/workspace/x'],
      ['POST', '/exec'],
      ['POST', '/kill'],
      ['POST', '/reopen'],
      ['POST', '/abort'],
      ['GET', '/nowhere'],
    ]) {
      assert.equal((await call(method, path, undefined, { key: '' })).status, 403, path);
      assert.equal((await call(method, path, undefined, { key: 'wrong' })).status, 403, path);
    }
  });

  test('boots cold, installs bash and coreutils, and runs the first command', async (t) => {
    if (skipped(t)) return;
    const start = performance.now();
    const boot = await json('GET', '/boot');
    const booted = performance.now() - start;
    assert.equal(boot.cold, true);
    assert.deepEqual(boot.mounts, ['workspace /workspace']);
    const first = await exec('echo hi');
    const total = performance.now() - start;
    assert.equal(first.stdout, 'hi\n', JSON.stringify(first));
    t.diagnostic(
      `cold: boot ${Math.round(booted)} ms (installed ${boot.installed}), first exec done at ${Math.round(total)} ms`
    );
    const warm = [];
    for (let i = 0; i < 5; i++) {
      const at = performance.now();
      assert.equal((await exec('true')).exitCode, 0);
      warm.push(performance.now() - at);
    }
    warm.sort((a, b) => a - b);
    t.diagnostic(
      `warm exec of true: median ${Math.round(warm[2])} ms, min ${Math.round(warm[0])} ms`
    );
  });

  test('a file written with workspace.fs is seen by cat, and the reverse', async (t) => {
    if (skipped(t)) return;
    assert.equal((await put('/workspace/both/from-fs.txt', 'from workspace.fs\n')).httpStatus, 200);
    const seen = await exec('cat both/from-fs.txt');
    assert.equal(seen.stdout, 'from workspace.fs\n', JSON.stringify(seen));
    const wrote = await exec(
      'printf "from bash\\n" > both/from-bash.txt && chmod +x both/from-bash.txt'
    );
    assert.equal(wrote.exitCode, 0, wrote.stderr);
    assert.deepEqual(await read('/workspace/both/from-bash.txt'), {
      status: 200,
      text: 'from bash\n',
    });
  });

  test('a coreutils pipeline over files in /workspace', async (t) => {
    if (skipped(t)) return;
    for (const [name, text] of [
      ['a.txt', 'pear\napple\nfig\n'],
      ['b.txt', 'apple\nfig\napple\n'],
      ['c.txt', 'kiwi\napple\n'],
    ]) {
      await put(`/workspace/fruit/${name}`, text);
    }
    const result = await exec(
      'cat fruit/*.txt | tr a-z A-Z | sort | uniq -c | sort -rn > fruit/counts.txt; head -2 fruit/counts.txt | tr -s " " | cut -c2- > fruit/top.txt; wc -l < fruit/top.txt; cat fruit/top.txt'
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, '2\n4 APPLE\n2 FIG\n');
    assert.equal((await read('/workspace/fruit/top.txt')).text, '4 APPLE\n2 FIG\n');
  });

  test('a pipeline of eight processes redirected into a file', async (t) => {
    if (skipped(t)) return;
    await put('/workspace/fruit/long.txt', 'pear\napple\nfig\napple\nkiwi\napple\nfig\n');
    const result = await exec(
      'cat fruit/long.txt | tr a-z A-Z | sort | uniq -c | sort -rn | head -2 | tr -s " " | cut -c2- > fruit/long-top.txt; cat fruit/long-top.txt'
    );
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '3 APPLE\n2 FIG\n');
  });

  test('streams output before the run exits', async (t) => {
    if (skipped(t)) return;
    const events = await streamed('echo one; sleep 1; echo two >&2; sleep 1; echo three');
    assert.deepEqual(
      events.map((event) => [event.name, event.value ?? event.code]),
      [
        ['stdout', 'one\n'],
        ['stderr', 'two\n'],
        ['stdout', 'three\n'],
        ['exit', 0],
      ]
    );
    const [one, , , exit] = events;
    assert.ok(exit.at - one.at > 1500, `one came ${Math.round(exit.at - one.at)} ms before exit`);
  });

  test('killExec ends a sleep 100', async (t) => {
    if (skipped(t)) return;
    const id = `kill-${crypto.randomUUID()}`;
    const start = performance.now();
    let killed;
    const events = await streamed('echo started; sleep 100', { id }, async (event) => {
      if (event.name === 'stdout' && !killed) {
        killed = await json('POST', '/kill', JSON.stringify({ id }));
      }
    });
    assert.equal(killed?.killed, id, JSON.stringify(killed));
    assert.deepEqual(events.at(-1).name, 'exit');
    assert.equal(events.at(-1).code, 143);
    assert.ok(performance.now() - start < 30_000);
    const timed = await exec('sleep 100', { timeoutMs: 1000 });
    assert.equal(timed.status, 'cancelled');
    assert.equal(timed.exitCode, 143);
  });

  test('reconnects after the Workspace closes, and when it is replaced unclosed', async (t) => {
    if (skipped(t)) return;
    await put('/workspace/reconnect.txt', 'still here\n');
    const closed = await json('POST', '/reopen');
    assert.equal(closed.closed, true);
    assert.equal((await exec('cat reconnect.txt')).stdout, 'still here\n');
    const replaced = await json('POST', '/reopen', undefined);
    assert.equal(replaced.httpStatus, 200);
    const unclosed = await json('POST', '/reopen?close=false');
    assert.equal(unclosed.closed, false);
    const after = await exec('cat reconnect.txt');
    assert.equal(after.stdout, 'still here\n', JSON.stringify(after));
    assert.deepEqual((await json('GET', '/boot')).mounts, ['workspace /workspace']);
  });

  test('reads and writes 100 files in /workspace', async (t) => {
    if (skipped(t)) return;
    const start = performance.now();
    const result = await exec(
      'mkdir -p many && for i in $(seq 1 100); do echo "line $i" > many/f$i.txt; done; n=0; for f in many/*.txt; do read l < "$f"; n=$((n+1)); done; echo $n; cat many/*.txt | wc -l'
    );
    const took = performance.now() - start;
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, '100\n100\n');
    assert.equal((await read('/workspace/many/f42.txt')).text, 'line 42\n');
    t.diagnostic(`100 files written and read in one script: ${Math.round(took)} ms`);
  });

  test('a restart of the Durable Object keeps the files', async (t) => {
    if (skipped(t)) return;
    await put('/workspace/kept/by-fs.txt', 'kept by fs\n');
    assert.equal((await exec('echo kept by bash > kept/by-bash.txt')).exitCode, 0);
    await call('POST', '/abort').catch(() => undefined);
    const start = performance.now();
    const boot = await json('GET', '/boot');
    assert.equal(boot.cold, true, JSON.stringify(boot));
    assert.equal(boot.installed, 0);
    const seen = await exec('cat kept/by-fs.txt kept/by-bash.txt');
    t.diagnostic(
      `cold on the persisted root after abort: ${Math.round(performance.now() - start)} ms`
    );
    assert.equal(seen.stdout, 'kept by fs\nkept by bash\n', JSON.stringify(seen));
    await restartedDev();
    if (dev.skip) return t.skip(dev.skip);
    assert.equal((await read('/workspace/kept/by-bash.txt')).text, 'kept by bash\n');
    assert.equal((await exec('cat kept/by-fs.txt')).stdout, 'kept by fs\n');
  });
});
