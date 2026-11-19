import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { resetRetried } from './cloudflare-fixture/dev.mjs';

async function serving(resetsFirst, status = 200) {
  const sockets = [];
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (requests <= resetsFirst) {
      request.socket.resetAndDestroy();
      return;
    }
    response.writeHead(status).end(`answer ${requests}`);
  });
  server.on('connection', (socket) => sockets.push(socket.remotePort));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/x`,
    connections: () => new Set(sockets).size,
    requests: () => requests,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a connection reset before any answer is sent again on a new connection, and the retry is reported', async () => {
  const server = await serving(1);
  const retries = [];
  try {
    const send = resetRetried(fetch, {
      waitMs: 1,
      onRetry: (err, at) => retries.push([err.cause.code, at]),
    });
    const response = await send(server.url, { method: 'POST', body: 'same body' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'answer 2');
    assert.equal(server.connections(), 2);
    assert.deepEqual(retries, [['ECONNRESET', { url: server.url, method: 'POST', attempt: 1 }]]);
  } finally {
    await server.close();
  }
});

test('a connection that is reset every time fails with ECONNRESET after three tries', async () => {
  const server = await serving(Infinity);
  try {
    const send = resetRetried(fetch, { waitMs: 1 });
    await assert.rejects(send(server.url), (err) => err.cause?.code === 'ECONNRESET');
    assert.equal(server.requests(), 3);
  } finally {
    await server.close();
  }
});

test('an error answer and a refused connection are not sent again', async () => {
  const server = await serving(0, 500);
  let retried = 0;
  const send = resetRetried(fetch, { waitMs: 1, onRetry: () => retried++ });
  try {
    assert.equal((await send(server.url)).status, 500);
    assert.equal(server.requests(), 1);
  } finally {
    await server.close();
  }
  await assert.rejects(send(server.url), (err) => err.cause?.code === 'ECONNREFUSED');
  assert.equal(retried, 0);
});
