import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

async function attached(page, name) {
  return page.evaluate(async (n) => {
    const agent = window.agent();
    window[n] = agent;
    const port = await window.kernel.connect();
    return agent.ask('attach', { port }, [port]);
  }, name);
}

const ask = (page, name, action, payload = {}) =>
  page.evaluate((n, a, p) => window[n].ask(a, p), name, action, payload);
const events = (page, name) => page.evaluate((n) => window[n].events, name);

test('a worker attaches, its sleep shows in a terminal, the terminal kills it, and the worker sees the exit', async (t) => {
  const { page } = await booted(chrome, t);
  assert.deepEqual(await attached(page, 'a'), { protocol: [1, 1] });
  const { pid, pgid } = await ask(page, 'a', 'spawn', { argv: ['sleep', '100'] });
  assert.equal(pgid, pid);
  const listed = await ask(page, 'a', 'ps');
  assert.deepEqual(
    listed.filter((p) => p.pid === pid).map((p) => [p.argv, p.state]),
    [[['sleep', '100'], 'S']]
  );

  await page.evaluate(() => window.terminal(['bash', '-i'], { cwd: '/home' }));
  await page.until(() => window.screen.screen.includes('$ '));
  await page.evaluate(() =>
    window.term.write('for d in /proc/[0-9]*; do echo "pid ${d#/proc/} $(cat $d/comm)"; done\r')
  );
  await page.until((p) => window.screen.screen.includes(`pid ${p} sleep`), pid);
  await page.evaluate((p) => window.term.write(`kill ${p}\r`), pid);
  await page.until((p) => window.a.events.some((e) => e.event === 'exited' && e.pid === p), pid);
  const exit = (await events(page, 'a')).find((e) => e.event === 'exited');
  assert.deepEqual([exit.pid, exit.status], [pid, 143]);
  assert.deepEqual(page.errors, []);
});

test('a detached client leaves its processes running, and a gone kernel fails a client instead of hanging', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await attached(page, 'a');
  const { pid } = await ask(page, 'a', 'spawn', { argv: ['sleep', '100'] });
  await ask(page, 'a', 'close', { kill: false });
  await page.until(() => window.a.events.some((e) => e.event === 'closed'));
  const kept = await bash(`cat /proc/${pid}/comm`);
  assert.deepEqual([kept.status, kept.stdout], [0, 'sleep\n']);

  await attached(page, 'b');
  const second = await ask(page, 'b', 'spawn', { argv: ['sleep', '100'] });
  await page.evaluate(() => window.kernel.terminate());
  await page.until(
    (p) => window.b.events.some((e) => e.event === 'exited' && e.pid === p),
    second.pid
  );
  const seen = await events(page, 'b');
  assert.deepEqual(
    seen.filter((e) => e.event !== 'forwarded').map((e) => e.error ?? e.name),
    ['KernelGoneError', 'KernelGoneError']
  );
  assert.deepEqual(page.errors, []);
});

test('a port survives a second transfer; files, fetch, refusal of another protocol and a silent port', async (t) => {
  const { page } = await booted(chrome, t);
  await page.evaluate(async () => {
    window.a = window.agent();
    window.b = window.agent();
    const port = await window.kernel.connect();
    await window.a.ask('forward', { port }, [port]);
  });
  await page.until(() => window.a.events.some((e) => e.event === 'forwarded'));
  const protocol = await page.evaluate(() => {
    const { port } = window.a.events.find((e) => e.event === 'forwarded');
    return window.b.ask('attach', { port }, [port]);
  });
  assert.deepEqual(protocol, { protocol: [1, 1] });

  assert.deepEqual(await ask(page, 'b', 'files'), {
    listed: ['a.txt'],
    text: 'from the agent',
    missing: 'ENOENT',
  });
  const fetched = await page.evaluate(() =>
    window.b.ask('fetchText', { url: new URL('/dist/index.js', location.href).href })
  );
  assert.equal(fetched.status, 200);
  assert.match(fetched.text, /attachKernel/);

  const refused = await page.evaluate(async () => {
    const port = await window.kernel.connect();
    const answer = new Promise((resolve) => {
      const seen = [];
      port.onmessage = ({ data }) => {
        seen.push(Object.keys(data)[0]);
        if (data.bye) resolve(`${seen.join(',')}: ${data.bye}: ${hello}`);
        else hello = data.hello.error;
      };
      let hello;
    });
    port.postMessage({ hello: { protocol: [2, 0] } });
    return answer;
  });
  assert.match(
    refused,
    /^hello,bye: the slicc-kernel detached this client: slicc-kernel client protocol 2\.x is not supported: this side speaks 1\.1$/
  );
  const silent = await page.evaluate(() =>
    window
      .attachKernel(new MessageChannel().port1, { timeoutMs: 200 })
      .catch((e) => `${e.name}: ${e.message}`)
  );
  assert.equal(silent, 'KernelGoneError: no slicc-kernel answered on this port within 200 ms');
  assert.deepEqual(page.errors, []);
});

test('a worker watches files, and sees what the page’s processes write', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await attached(page, 'a');
  await ask(page, 'a', 'watch', { paths: ['/home/agent'], recursive: true });
  assert.deepEqual(
    await bash(
      'mkdir -p /home/agent/out && echo done > /home/agent/out/result.txt; echo x > /home/other.txt'
    ),
    { status: 0, stdout: '', stderr: '' }
  );
  await page.until(() =>
    window.a.events.some(
      (e) => e.event === 'changed' && e.change.paths.includes('/home/agent/out/result.txt')
    )
  );
  const seen = (await events(page, 'a')).flatMap((e) => e.change?.paths ?? []);
  assert.ok(!seen.includes('/home/other.txt'), seen.join(' '));
  assert.deepEqual(page.errors, []);
});
