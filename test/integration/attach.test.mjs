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
  assert.deepEqual(await attached(page, 'a'), { protocol: [1, 4] });
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

test('a worker spawns into its own process group, and kill -- -pgid from a terminal ends every member', async (t) => {
  const { page } = await booted(chrome, t);
  await attached(page, 'a');
  const leader = await ask(page, 'a', 'spawn', { argv: ['sleep', '100'] });
  const member = await ask(page, 'a', 'spawn', { argv: ['sleep', '100'], pgid: leader.pid });
  assert.equal(member.pgid, leader.pid);
  const groups = (await ask(page, 'a', 'ps'))
    .filter((p) => p.pid === leader.pid || p.pid === member.pid)
    .map((p) => p.pgid);
  assert.deepEqual(groups, [leader.pid, leader.pid]);
  await page.evaluate(() => window.terminal(['bash', '-i'], { cwd: '/home' }));
  await page.until(() => window.screen.screen.includes('$ '));
  await page.evaluate((g) => window.term.write(`kill -- -${g}\r`), leader.pid);
  await page.until(
    (pids) => pids.every((p) => window.a.events.some((e) => e.event === 'exited' && e.pid === p)),
    [leader.pid, member.pid]
  );
  const exits = (await events(page, 'a')).filter((e) => e.event === 'exited').map((e) => e.status);
  assert.deepEqual(exits, [143, 143]);
  assert.deepEqual(page.errors, []);
});

test('the page and a worker reach a kernel server: dial, a streamed SSE fetch, a script, and ECONNREFUSED', async (t) => {
  const { page } = await booted(chrome, t);
  await page.evaluate(() => {
    window.server = window.kernel.run(['httptest', '8400']);
  });
  await page.until(async () => {
    try {
      (await window.kernel.dial({ port: 8400 })).close();
      return true;
    } catch {
      return false;
    }
  });
  const raw = await page.evaluate(async () => {
    const socket = await window.kernel.dial({ port: 8400 });
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode('GET /file HTTP/1.1\r\nHost: x\r\n\r\n'));
    await writer.close();
    let text = '';
    for await (const chunk of socket.readable) text += new TextDecoder().decode(chunk);
    return text;
  });
  assert.match(raw, /^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\nhello from the kernel\n$/);
  const sse = await page.evaluate(async () => {
    const response = await window.kernel.loopbackFetch('http://8400.kernel.localhost/events', {
      port: 8400,
    });
    const reader = response.body.getReader();
    const seen = [];
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      seen.push([new TextDecoder().decode(next.value), performance.now()]);
    }
    return { type: response.headers.get('content-type'), seen };
  });
  assert.equal(sse.type, 'text/event-stream');
  assert.deepEqual(
    sse.seen.map(([data]) => data),
    ['data: event 1\n\n', 'data: event 2\n\n', 'data: event 3\n\n']
  );
  assert.ok(sse.seen[2][1] - sse.seen[0][1] >= 150, 'the events arrive as they are sent');
  const script = await page.evaluate(async () => {
    const response = await window.kernel.loopbackFetch('http://8400.kernel.localhost/x.js', {
      port: 8400,
    });
    return response.text();
  });
  assert.equal(script, "globalThis.fromKernel = 'hello from the kernel';\n");
  const refused = await page.evaluate(() =>
    window.kernel.dial({ port: 8499 }).then(
      () => 'connected',
      (error) => error.code
    )
  );
  assert.equal(refused, 'ECONNREFUSED');
  await attached(page, 'a');
  assert.deepEqual(
    await ask(page, 'a', 'loopback', { url: 'http://8400.kernel.localhost/file', port: 8400 }),
    { status: 200, text: 'hello from the kernel\n' }
  );
  assert.deepEqual(
    await ask(page, 'a', 'loopback', { url: 'http://8499.kernel.localhost/', port: 8499 }),
    { code: 'ECONNREFUSED' }
  );
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
  assert.deepEqual(protocol, { protocol: [1, 4] });

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
    /^hello,bye: the slicc-kernel detached this client: slicc-kernel client protocol 2\.x is not supported: this side speaks 1\.4$/
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
