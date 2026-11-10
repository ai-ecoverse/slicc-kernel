import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const DUMMY_COOKIE = 'session=dummy-not-a-credential';
const REFERER = 'https://referer.test/page';
const FORBIDDEN = { Cookie: DUMMY_COOKIE, Referer: REFERER };
const ORDINARY = { 'X-Probe': 'visible' };

const chrome = await launch();
const asked = [];
let server;
let base;
before(async () => {
  server = createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.url.startsWith('/echo')) {
      asked.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(JSON.stringify(req.headers));
      return;
    }
    if (req.url === '/exit') {
      let text = '';
      for await (const chunk of req) text += chunk;
      const request = JSON.parse(text);
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
      });
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
          body: await response.text(),
        })
      );
      return;
    }
    res.writeHead(404, cors);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://host.slicc.internal:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await chrome.close();
});

const PROGRAM = `export default async function main(ctx) {
  const [mode, url, given] = ctx.argv.slice(1);
  const headers = JSON.parse(given);
  const shown = (err) => JSON.stringify({
    name: err.name,
    message: err.message,
    cause: {
      name: err.cause?.name,
      code: err.cause?.code,
      message: err.cause?.message,
      detail: err.cause?.detail ?? null,
    },
  });
  if (mode === 'loopback') {
    const listener = await ctx.net.listen({ port: 0 });
    const served = listener.accept().then(async (c) => {
      const reader = c.readable.getReader();
      let head = '';
      while (!head.includes('\\r\\n\\r\\n')) head += new TextDecoder().decode((await reader.read()).value);
      const seen = {};
      for (const line of head.split('\\r\\n').slice(1).filter(Boolean)) {
        const at = line.indexOf(':');
        seen[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
      }
      const body = new TextEncoder().encode(JSON.stringify(seen));
      const w = c.writable.getWriter();
      await w.write(new TextEncoder().encode('HTTP/1.1 200 OK\\r\\nContent-Length: ' + body.length + '\\r\\n\\r\\n'));
      await w.write(body);
      await w.close();
      await c.close();
      await listener.close();
    });
    const r = await ctx.fetch('http://127.0.0.1:' + listener.port + '/echo', { headers });
    await ctx.write(1, (await r.text()) + '\\n');
    await served;
    return;
  }
  const line = await ctx.fetch(url, { headers }).then(
    async (r) => 'status ' + r.status + ' ' + (await r.text()),
    shown
  );
  await ctx.write(1, line + '\\n');
}
`;

async function withProgram(t, options) {
  const kernel = await booted(chrome, t, options);
  await kernel.page.evaluate(async (program) => {
    const pkg = {
      name: 'headerfetch',
      slicc: { commands: { headerfetch: { abi: 'js', module: 'main.mjs' } } },
    };
    await window.opfs.write('node_modules/headerfetch/package.json', JSON.stringify(pkg));
    await window.opfs.write('node_modules/headerfetch/main.mjs', program);
  }, PROGRAM);
  const fetchWith = async (mode, url, headers) => {
    const { status, stdout, stderr } = await kernel.run(
      ['headerfetch', mode, url, JSON.stringify(headers)],
      { cwd: '/' }
    );
    assert.equal(stderr, '');
    assert.equal(status, 0);
    return stdout.trimEnd();
  };
  return { ...kernel, fetchWith };
}

const echoed = (line) => {
  const match = /^status 200 (.*)$/s.exec(line);
  assert.ok(match, line);
  return JSON.parse(match[1]);
};

const curlArgs = (headers) =>
  Object.entries(headers)
    .map(([name, value]) => `-H '${name}: ${value}'`)
    .join(' ');

test("ctx.fetch through the page's own fetch refuses Cookie and Referer with ENOTSUP naming them, and never sends the request (#1796)", async (t) => {
  const { fetchWith } = await withProgram(t);
  const before = asked.length;
  const line = await fetchWith('fetch', `${base}/echo/page-forbidden`, {
    ...ORDINARY,
    ...FORBIDDEN,
  });
  const err = JSON.parse(line);
  assert.equal(err.name, 'TypeError');
  assert.equal(err.message, 'fetch failed');
  assert.equal(err.cause.name, 'JsCallError');
  assert.equal(err.cause.code, 'ENOTSUP');
  assert.equal(err.cause.detail, 'forbidden-header');
  assert.match(
    err.cause.message,
    /^net-head: fetch http:\/\/127\.0\.0\.1:\d+\/echo\/page-forbidden refused: the page's fetch can't send the request headers cookie, referer, so it was not sent: ENOTSUP$/
  );
  assert.equal(
    asked.slice(before).some((a) => a.url === '/echo/page-forbidden'),
    false,
    'the refused request must not reach the server'
  );
});

test("ctx.fetch through the page's own fetch still sends ordinary headers (#1796)", async (t) => {
  const { fetchWith } = await withProgram(t);
  const seen = echoed(await fetchWith('fetch', `${base}/echo/page-ordinary`, ORDINARY));
  assert.equal(seen['x-probe'], 'visible');
  assert.equal(seen.cookie, undefined);
});

test("curl through the page's own fetch gets a 502 naming Cookie and Referer instead of a silent drop, and ordinary headers still go (#1796)", async (t) => {
  const { bash } = await withProgram(t);
  const before = asked.length;
  const refused = await bash(
    `curl -sS -w " %{http_code}" ${curlArgs({ ...ORDINARY, ...FORBIDDEN })} ${base}/echo/curl-forbidden`,
    { cwd: '/' }
  );
  assert.match(refused.stdout, /can't send the request headers cookie, referer/);
  assert.match(refused.stdout, / 502$/);
  assert.equal(
    asked.slice(before).some((a) => a.url === '/echo/curl-forbidden'),
    false
  );
  const plain = await bash(
    `curl -sS --compressed ${curlArgs(ORDINARY)} ${base}/echo/curl-ordinary`,
    { cwd: '/' }
  );
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(plain.stdout)['x-probe'], 'visible');
});

const ROUTES = {
  exit: 'an exit that takes headers as data',
  extension: "fetchTransport with an extension's fetch",
};

for (const [route, what] of Object.entries(ROUTES)) {
  test(`ctx.fetch through ${what} delivers Cookie and Referer, as curl does (#1796)`, async (t) => {
    const exit = `http://127.0.0.1:${server.address().port}/exit`;
    const { fetchWith, bash } = await withProgram(t, { [route]: exit });
    const seen = echoed(
      await fetchWith('fetch', `${base}/echo/${route}`, { ...ORDINARY, ...FORBIDDEN })
    );
    assert.equal(seen['x-probe'], 'visible');
    assert.equal(seen.cookie, DUMMY_COOKIE);
    assert.equal(seen.referer, REFERER);
    const plain = echoed(await fetchWith('fetch', `${base}/echo/${route}-plain`, ORDINARY));
    assert.equal(plain['x-probe'], 'visible');
    assert.equal(plain.cookie, undefined);
    const curl = await bash(
      `curl -sS ${curlArgs({ ...ORDINARY, ...FORBIDDEN })} ${base}/echo/${route}-curl`,
      { cwd: '/' }
    );
    const viaCurl = JSON.parse(curl.stdout);
    assert.equal(viaCurl['x-probe'], 'visible');
    assert.equal(viaCurl.cookie, DUMMY_COOKIE);
    assert.equal(viaCurl.referer, REFERER);
  });
}

test("ctx.fetch to the kernel's own loopback delivers Cookie and Referer from a browser worker (#1796)", async (t) => {
  const { fetchWith } = await withProgram(t);
  const seen = JSON.parse(await fetchWith('loopback', '', { ...ORDINARY, ...FORBIDDEN }));
  assert.equal(seen['x-probe'], 'visible');
  assert.equal(seen.cookie, DUMMY_COOKIE);
  assert.equal(seen.referer, REFERER);
});

const SENT = [
  ['x-probe', 'visible'],
  ['cookie', DUMMY_COOKIE],
  ['referer', REFERER],
];

function transportBody(origin) {
  return `
    const { fetchTransport } = await import(${JSON.stringify(`${origin}/dist/index.js`)});
    const request = (headers) => ({
      url: 'https://headers.test/x',
      method: 'GET',
      headers,
      signal: new AbortController().signal,
    });
    const SENT = ${JSON.stringify(SENT)};
    const calls = [];
    const spy = async (_url, init) => {
      calls.push([...new Headers(init.headers)]);
      return new Response('ok');
    };
    const given = fetchTransport({ fetch: spy });
    await (await given.fetch(request(SENT))).cancel();
    const givenSaw = calls.at(-1);
    const native = globalThis.fetch;
    globalThis.fetch = spy;
    let own;
    let ownSaw = null;
    try {
      const before = calls.length;
      own = await fetchTransport().fetch(request(SENT)).then(
        () => 'sent',
        (e) => ({ message: e.message, code: e.code, status: e.status, detail: e.detail, headers: e.headers })
      );
      if (calls.length > before) ownSaw = calls.at(-1);
      await (await fetchTransport().fetch(request([['x-probe', 'visible'], ['accept-encoding', 'gzip'], ['connection', 'keep-alive']]))).cancel();
      const ordinary = calls.at(-1);
      const declared = await fetchTransport({ fetch: spy, forbiddenHeaders: 'refuse' }).fetch(request(SENT)).then(
        () => 'sent',
        (e) => e.detail
      );
      return { givenSaw, own, ownSaw, ordinary, declared };
    } finally {
      globalThis.fetch = native;
    }
  `;
}

test("fetchTransport(): a given fetch gets forbidden headers as data, the page's own refuses them, and its own headers are left to it (#1796)", async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const origin = await page.evaluate(() => location.origin);
  const result = await page.evaluate((text) => {
    const Async = (async () => {}).constructor;
    return new Async(text)();
  }, transportBody(origin));
  assert.deepEqual(result.givenSaw, [
    ['cookie', DUMMY_COOKIE],
    ['referer', REFERER],
    ['x-probe', 'visible'],
  ]);
  assert.equal(result.ownSaw, null, "the page's own fetch must not be called");
  assert.equal(result.own.code, 'ENOTSUP');
  assert.equal(result.own.status, 502);
  assert.equal(result.own.detail, 'forbidden-header');
  assert.deepEqual(result.own.headers, ['cookie', 'referer']);
  assert.match(result.own.message, /can't send the request headers cookie, referer/);
  assert.deepEqual(result.ordinary, [['x-probe', 'visible']]);
  assert.equal(result.declared, 'forbidden-header');
});

test("an attached client's transport.fetch through the page's own fetch rejects with detail 'forbidden-header', and sends ordinary headers (#1796)", async (t) => {
  const { page } = await withProgram(t);
  const before = asked.length;
  const result = await page.evaluate(
    async (url, cookie) => {
      const client = await window.attachKernel(await window.kernel.connect());
      try {
        const ask = (path, headers) =>
          client.transport.fetch({
            url: `${url}${path}`,
            method: 'GET',
            headers,
            signal: new AbortController().signal,
          });
        const refused = await ask('/echo/client-forbidden', [
          ['x-probe', 'visible'],
          ['cookie', cookie],
        ]).then(
          () => 'sent',
          (e) => ({ message: e.message, status: e.status, code: e.code, detail: e.detail })
        );
        const plain = await ask('/echo/client-ordinary', [['x-probe', 'visible']]);
        let text = '';
        for await (const chunk of plain.body) text += new TextDecoder().decode(chunk);
        return { refused, status: plain.status, text };
      } finally {
        client.close();
      }
    },
    `http://127.0.0.1:${server.address().port}`,
    DUMMY_COOKIE
  );
  assert.equal(result.refused.detail, 'forbidden-header');
  assert.equal(result.refused.code, 'ENOTSUP');
  assert.equal(result.refused.status, 502);
  assert.match(result.refused.message, /can't send the request header cookie, so it was not sent$/);
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.text)['x-probe'], 'visible');
  assert.equal(
    asked.slice(before).some((a) => a.url === '/echo/client-forbidden'),
    false
  );
});
