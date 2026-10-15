import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { nodeTransport } from '../../dist/node.js';

test('an abort while nodeTransport diagnoses a failed WebSocket open wins at once and stops the probe (#376)', {
  timeout: 30_000,
}, async (t) => {
  const sockets = [];
  const closed = [];
  let probing;
  const probed = new Promise((resolve) => (probing = resolve));
  const server = createServer((socket) => {
    const n = sockets.push(socket);
    socket.on('error', () => undefined);
    socket.resume();
    socket.on('close', () => closed.push(n));
    if (n === 1) socket.destroy();
    else probing();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const stop = new AbortController();
  const reason = new Error('gave up');
  const started = Date.now();
  const opening = nodeTransport({ hostLoopback: true }).websocket({
    url: `wss://localhost:${server.address().port}/`,
    protocols: [],
    headers: [],
    signal: stop.signal,
  });
  const outcome = opening.then(
    () => 'opened',
    (err) => err
  );
  await probed;
  stop.abort(reason);
  const err = await outcome;
  const took = Date.now() - started;
  assert.equal(err, reason);
  assert.ok(took < 2500, `took ${took} ms`);
  for (let i = 0; i < 50 && !closed.includes(2); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(closed.includes(2), `the probe connection is closed: ${sockets.length} ${closed}`);
});
