import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';

const chrome = await launch();
after(() => chrome.close());

const SENT = [
  ['User-Agent', 'pnpm/9'],
  ['Accept', '*/*'],
];

const withAgent = [
  ['accept', '*/*'],
  ['user-agent', 'pnpm/9'],
];

const withoutAgent = [['accept', '*/*']];

const request = (headers) => ({
  url: 'https://registry.test/x.tgz',
  method: 'GET',
  headers,
  signal: new AbortController().signal,
});

async function seen(fetchTransport, transportOptions, spy) {
  const transport = fetchTransport(transportOptions);
  const response = await transport.fetch(request(SENT));
  await response.cancel();
  return spy.calls.at(-1);
}

function spied() {
  const spy = async (_url, init) => {
    spy.calls.push([...init.headers]);
    return new Response('ok');
  };
  spy.calls = [];
  return spy;
}

function realmBody(origin) {
  const helpers = { seen: seen.toString(), spied: spied.toString(), request: request.toString() };
  const body = `
    const { fetchTransport } = await import(${JSON.stringify(`${origin}/dist/index.js`)});
    const seen = ${helpers.seen};
    const spied = ${helpers.spied};
    const request = ${helpers.request};
    const SENT = ${JSON.stringify(SENT)};
    const spy = spied();
    const native = globalThis.fetch;
    globalThis.fetch = spy;
    const own = await seen(fetchTransport, {}, spy);
    globalThis.fetch = native;
    const given = await seen(fetchTransport, { fetch: spy }, spy);
    return { own, given };
  `;
  return body;
}

test('a page and a worker leave user-agent out of their own fetch, and pass it to a given one', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  const origin = await page.evaluate(() => location.origin);
  const body = realmBody(origin);
  const inPage = await page.evaluate((text) => {
    const Async = (async () => {}).constructor;
    return new Async(text)();
  }, body);
  assert.deepEqual(inPage, { own: withoutAgent, given: withAgent });
  const inWorker = await page.evaluate((text) => {
    const source = `self.onmessage = async () => { const run = async () => { ${text} }; self.postMessage(await run()); };`;
    const worker = new Worker(
      URL.createObjectURL(new Blob([source], { type: 'text/javascript' })),
      {
        type: 'module',
      }
    );
    return new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage(0);
    });
  }, body);
  assert.deepEqual(inWorker, { own: withoutAgent, given: withAgent });
});

test('Node, with no location, keeps user-agent on its own fetch', async () => {
  const { fetchTransport } = await import('../../dist/node.js');
  assert.equal('location' in globalThis, false);
  const spy = spied();
  const native = globalThis.fetch;
  globalThis.fetch = spy;
  try {
    assert.deepEqual(await seen(fetchTransport, {}, spy), withAgent);
  } finally {
    globalThis.fetch = native;
  }
  assert.deepEqual(await seen(fetchTransport, { fetch: spy }, spy), withAgent);
});
