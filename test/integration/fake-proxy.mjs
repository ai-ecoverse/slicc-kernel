import { createServer } from 'node:http';

const frame = (head) => {
  const json = Buffer.from(JSON.stringify(head));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.byteLength);
  return Buffer.concat([length, json]);
};

const routes = {
  '/hello': () => ({
    status: 200,
    statusText: 'OK',
    headers: [
      ['content-type', 'text/plain'],
      ['set-cookie', 'a=1; Path=/'],
      ['set-cookie', 'b=2; Path=/'],
    ],
    body: 'hello through the local proxy\n',
  }),
  '/moved': () => ({
    status: 302,
    statusText: 'Found',
    headers: [
      ['location', '/hello'],
      ['content-length', '0'],
    ],
    body: '',
  }),
  '/echo': (body) => ({
    status: 201,
    statusText: 'Created',
    headers: [['content-type', 'text/plain']],
    body: `echo ${body}`,
  }),
};

export async function fakeProxy({ origin, key }) {
  const seen = [];
  const cors = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'X-Proxy-Error',
  };
  const refuse = (res, status, error, headers = cors) => {
    res.writeHead(status, { ...headers, 'X-Proxy-Error': '1', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error }));
  };
  const server = createServer(async (req, res) => {
    if (req.url !== '/api/fetch-proxy' || req.headers.origin !== origin) {
      refuse(res, 403, 'origin not allowed', {});
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, X-Bridge-Token, X-Slicc-Raw-Request, X-Slicc-Raw-Probe',
      });
      res.end();
      return;
    }
    if (req.headers['x-bridge-token'] !== key) {
      refuse(res, 403, 'proxy key missing or wrong');
      return;
    }
    if (req.headers['x-slicc-raw-probe'] && !req.headers['x-slicc-raw-request']) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ rawFetch: 1, requestBodyStreaming: false, maxRequestBodyBytes: 1024 })
      );
      return;
    }
    const head = JSON.parse(req.headers['x-slicc-raw-request']);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    seen.push({ ...head, body });
    const route = routes[new URL(head.url).pathname];
    if (!route) {
      refuse(res, 502, `fetch failed: ${head.url}`);
      return;
    }
    const answer = route(body);
    res.writeHead(200, { ...cors, 'Content-Type': 'application/vnd.slicc.raw-fetch' });
    res.write(
      frame({
        status: answer.status,
        statusText: answer.statusText,
        headers: answer.headers,
        url: head.url,
      })
    );
    res.end(answer.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
