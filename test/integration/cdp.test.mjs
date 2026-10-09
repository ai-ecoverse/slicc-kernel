import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const port = await new Promise((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const chrome = await launch([`--remote-debugging-port=${port}`]);
after(() => chrome.close());
const browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
  .webSocketDebuggerUrl;

function relay(page) {
  const sockets = new Map();
  const deliver = (...args) =>
    page.evaluate((id, m, closed) => window.cdpIn(id, m, closed), ...args).catch(() => false);
  page.expose('cdpOut', ({ id, open, m, close }) => {
    if (open) {
      const ws = new WebSocket(browser);
      const queued = [];
      ws.onopen = () => {
        for (const text of queued.splice(0)) ws.send(text);
      };
      ws.onmessage = ({ data }) => void deliver(id, data);
      ws.onclose = () => void deliver(id, null, 'the browser closed');
      sockets.set(id, { ws, queued });
    } else if (m !== undefined) {
      const { ws, queued } = sockets.get(id);
      if (ws.readyState === WebSocket.OPEN) ws.send(m);
      else queued.push(m);
    } else if (close) {
      sockets.get(id)?.ws.close();
      sockets.delete(id);
    }
  });
  return sockets;
}

test('a WASI guest drives the harness browser through the CDP facade', async (t) => {
  const { page, run } = await booted(chrome, t, { cdp: true });
  const sockets = relay(page);
  await installPackage(page, 'wasix-python');
  const client = await readFile(new URL('fixtures/cdp/client.py', import.meta.url), 'utf8');
  assert.equal((await run(['bash', '-c', 'cat > /home/client.py'], { stdin: client })).status, 0);

  const target = new URL('/fixtures/cdp/page.html', chrome.url).href;
  const r = await run(['python3', '/home/client.py', 'drive', target], { cwd: '/home' });
  assert.equal(r.stderr, '');
  assert.match(
    r.stdout,
    /^targets [1-9]\d*\nnavigated True False\nscreenshot 89504e470d0a1a0a\ndone\n$/
  );
  assert.equal(sockets.size, 0);
  assert.deepEqual(page.errors, []);
});

test('the page cannot dial the CDP facade, by port or through loopbackFetch', async (t) => {
  const { page } = await booted(chrome, t, { cdp: true });
  const refused = await page.evaluate(async () => {
    const dial = await window.kernel.dial({ port: 9222 }).then(
      () => 'open',
      (e) => `${e.code}: ${e.message}`
    );
    const fetched = await window.kernel
      .loopbackFetch('http://127.0.0.1/json/version', { port: 9222 })
      .then(
        (r) => r.status,
        (e) => e.code
      );
    return { dial, fetched };
  });
  assert.deepEqual(refused, {
    dial: 'ECONNREFUSED: ECONNREFUSED: port 9222 only takes connections from inside the kernel',
    fetched: 'ECONNREFUSED',
  });
});
