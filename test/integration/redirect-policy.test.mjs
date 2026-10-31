import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { attachKernel, createNodeKernel, fetchTransport, nodeTransport } from '../../dist/node.js';

const TRAITS = { manualRedirects: false, encodedBodies: false, maxRequestBody: 1024 };

const empty = async function* () {};

function answer(fields = {}) {
  return {
    status: 200,
    statusText: 'OK',
    headers: [],
    body: empty(),
    cancel: async () => undefined,
    ...fields,
  };
}

async function listen(t, handler) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { hits, origin: `http://127.0.0.1:${server.address().port}` };
}

const hopping = (t) =>
  listen(t, (req, res) => {
    if (req.url === '/hop') res.writeHead(302, { location: '/final' }).end();
    else res.writeHead(200).end('final');
  });

async function clientOf(t, transport) {
  const kernel = await createNodeKernel({ users: 'off', network: { transport } });
  t.after(() => kernel.terminate());
  const client = await attachKernel(await kernel.connect());
  t.after(() => client.close());
  return { kernel, client };
}

const get = (client, url, redirect) =>
  client.fetch({ url, method: 'GET', headers: [], ...(redirect ? { redirect } : {}) });

async function text(response) {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of response.body) out += decoder.decode(chunk, { stream: true });
  return out;
}

function location(response) {
  return response.headers.find(([name]) => name.toLowerCase() === 'location')?.[1];
}

function recording(respond = () => answer(), traits = { redirectPolicy: true }) {
  const seen = [];
  return {
    seen,
    transport: {
      traits: { ...TRAITS, ...traits },
      fetch: async (request) => {
        seen.push(request);
        return respond(request);
      },
    },
  };
}

function hopsTransport() {
  const final = 'https://hops.test/final';
  return recording(
    (request) => {
      if (request.url === final) return answer();
      if (request.redirect === 'manual') {
        return answer({ status: 302, headers: [['location', final]] });
      }
      return answer({
        url: final,
        redirected: true,
        redirects: [{ status: 302, url: request.url, headers: [['location', final]] }],
      });
    },
    { redirectPolicy: true, redirectHops: true }
  );
}

const refused = { status: 502, detail: 'transport' };

test('a per-request manual hands the 3xx back from a transport that follows', async (t) => {
  const { hits, origin } = await hopping(t);
  const { client } = await clientOf(t, fetchTransport());
  const response = await get(client, `${origin}/hop`, 'manual');
  assert.equal(response.status, 302);
  assert.equal(location(response), '/final');
  assert.ok(!response.redirected);
  assert.equal(response.redirects, undefined);
  assert.deepEqual(hits, ['/hop']);
  assert.equal(client.transport.traits.manualRedirects, false);
});

test('a per-request follow follows on a transport that is manual, through its loopback guard', async (t) => {
  const { hits, origin } = await hopping(t);
  const { client } = await clientOf(t, nodeTransport({ hostLoopback: true }));
  const response = await get(client, `${origin}/hop`, 'follow');
  assert.equal(response.status, 200);
  assert.equal(response.redirected, true);
  assert.equal(response.url, `${origin}/final`);
  assert.equal(await text(response), 'final');
  assert.deepEqual(hits, ['/hop', '/final']);
});

test('a followed redirect may not leave the loopback guard', async (t) => {
  const open = await listen(t, (_req, res) => res.writeHead(200).end('open'));
  const { hits, origin } = await listen(t, (_req, res) =>
    res.writeHead(302, { location: `${open.origin}/` }).end()
  );
  const transport = nodeTransport({ hostLoopback: [Number(new URL(origin).port)] });
  const { client } = await clientOf(t, transport);
  await assert.rejects(get(client, `${origin}/hop`, 'follow'));
  assert.deepEqual(hits, ['/hop']);
  assert.deepEqual(open.hits, []);
});

test('a per-request error fails on a redirect, and only on a redirect', async (t) => {
  for (const transport of [fetchTransport(), nodeTransport({ hostLoopback: true })]) {
    const { hits, origin } = await hopping(t);
    const { client } = await clientOf(t, transport);
    await assert.rejects(get(client, `${origin}/hop`, 'error'), refused);
    assert.deepEqual(hits, ['/hop']);
    const plain = await get(client, `${origin}/final`, 'error');
    assert.equal(await text(plain), 'final');
  }
});

test('with no policy each transport does what it did', async (t) => {
  const manual = await hopping(t);
  const { client: raw } = await clientOf(t, nodeTransport({ hostLoopback: true }));
  const unfollowed = await get(raw, `${manual.origin}/hop`);
  assert.equal(unfollowed.status, 302);
  assert.equal(location(unfollowed), '/final');
  assert.deepEqual(manual.hits, ['/hop']);
  assert.equal(raw.transport.traits.manualRedirects, true);

  const instance = await hopping(t);
  const { client: pinned } = await clientOf(t, fetchTransport({ redirect: 'manual' }));
  assert.equal((await get(pinned, `${instance.origin}/hop`)).status, 302);
  assert.deepEqual(instance.hits, ['/hop']);

  const following = await hopping(t);
  const { client } = await clientOf(t, fetchTransport());
  const followed = await get(client, `${following.origin}/hop`);
  assert.equal(followed.status, 200);
  assert.equal(followed.redirected, true);
  assert.equal(followed.url, `${following.origin}/final`);
});

test('the field reaches the transport as sent, and stays away when it was not', async (t) => {
  const { seen, transport } = recording();
  const { client } = await clientOf(t, transport);
  for (const redirect of ['follow', 'manual', 'error', undefined]) {
    await get(client, 'https://field.test/', redirect);
  }
  assert.deepEqual(
    seen.map((request) => request.redirect),
    ['follow', 'manual', 'error', undefined]
  );
  assert.equal('redirect' in seen[3], false);
});

test('a request a program sends carries no policy', async (t) => {
  const { seen, transport } = recording();
  const { kernel } = await clientOf(t, transport);
  await kernel.writeFile(
    '/node_modules/asks/package.json',
    JSON.stringify({ name: 'asks', slicc: { commands: { asks: { abi: 'js', module: 'a.mjs' } } } })
  );
  await kernel.writeFile(
    '/node_modules/asks/a.mjs',
    `export default async (ctx) => { await ctx.fetch('https://program.test/'); };`
  );
  const { status, stderr } = await kernel.run(['asks'], { cwd: '/' });
  assert.equal(stderr, '');
  assert.equal(status, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].redirect, undefined);
});

test('an explicit manual neither fills nor reads the held chain, and answers no hops', async (t) => {
  const { seen, transport } = hopsTransport();
  const { client } = await clientOf(t, transport);
  assert.equal(client.transport.traits.manualRedirects, true);
  assert.equal(client.transport.traits.redirectHops, true);

  const manual = await get(client, 'https://hops.test/hop', 'manual');
  assert.equal(manual.status, 302);
  assert.equal(manual.redirects, undefined);
  assert.equal(seen.length, 1);
  assert.equal((await get(client, 'https://hops.test/final')).status, 200);
  assert.equal(seen.length, 2);

  assert.equal((await get(client, 'https://hops.test/hop')).status, 302);
  assert.equal(seen.length, 3);
  assert.equal((await get(client, 'https://hops.test/final', 'manual')).status, 200);
  assert.equal(seen.length, 4);
  assert.equal((await get(client, 'https://hops.test/final')).status, 200);
  assert.equal(seen.length, 4);
});

test('an explicit follow answers the end of the chain, not its first hop', async (t) => {
  const { seen, transport } = hopsTransport();
  const { client } = await clientOf(t, transport);
  const response = await get(client, 'https://hops.test/hop', 'follow');
  assert.equal(response.status, 200);
  assert.equal(response.url, 'https://hops.test/final');
  assert.equal(seen.length, 1);
  await get(client, 'https://hops.test/final');
  assert.equal(seen.length, 2);
});

test('a transport that cannot honor a policy is never asked', async (t) => {
  for (const traits of [{}, { redirectHops: true }]) {
    const { seen, transport } = recording(() => answer(), traits);
    const { client } = await clientOf(t, transport);
    await assert.rejects(get(client, 'https://old.test/', 'manual'), refused);
    await assert.rejects(get(client, 'https://old.test/', 'error'), refused);
    assert.equal(seen.length, 0);
    await get(client, 'https://old.test/', 'follow');
    await get(client, 'https://old.test/');
    assert.equal(seen.length, 2);
  }
});

test('a raw manual transport that knows no policy keeps manual and refuses error', async (t) => {
  const { seen, transport } = recording(() => answer({ status: 302 }), { manualRedirects: true });
  const { client } = await clientOf(t, transport);
  assert.equal((await get(client, 'https://raw.test/', 'manual')).status, 302);
  await assert.rejects(get(client, 'https://raw.test/', 'error'), refused);
  assert.equal(seen.length, 1);
});

test('a client refuses a policy its kernel does not advertise', async (t) => {
  const { seen, transport } = recording();
  const { client } = await clientOf(t, transport);
  client.transport.traits = { ...client.transport.traits, redirectPolicy: undefined };
  await assert.rejects(get(client, 'https://old.test/', 'manual'), refused);
  assert.equal(seen.length, 0);
});

test('a transport that followed anyway is an error, not an answer', async (t) => {
  const followed = [
    { url: 'https://liar.test/final', redirected: true },
    { redirects: [{ status: 302, url: 'https://liar.test/', headers: [] }] },
  ];
  for (const fields of followed) {
    let cancelled = 0;
    const { transport } = recording(() =>
      answer({
        ...fields,
        cancel: async () => {
          cancelled += 1;
        },
      })
    );
    const { client } = await clientOf(t, transport);
    await assert.rejects(get(client, 'https://liar.test/', 'manual'), refused);
    await assert.rejects(get(client, 'https://liar.test/', 'error'), refused);
    for (let at = 0; at < 100 && cancelled < 2; at++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(cancelled, 2);
    assert.equal((await get(client, 'https://liar.test/', 'follow')).status, 200);
  }
});

test('url and redirected cross the wire as the transport said them', async (t) => {
  const url = 'https://wire.test/elsewhere';
  const { transport } = recording(() => answer({ url, redirected: false }));
  const { client } = await clientOf(t, transport);
  const response = await get(client, 'https://wire.test/', 'manual');
  assert.equal(response.url, url);
  assert.equal(response.redirected, false);
});

test('the opaque marker crosses the wire with nothing made up', async (t) => {
  const { transport } = recording(() =>
    answer({ status: 0, statusText: '', opaqueRedirect: true })
  );
  const { client } = await clientOf(t, transport);
  const response = await get(client, 'https://opaque.test/', 'manual');
  assert.equal(response.opaqueRedirect, true);
  assert.equal(response.status, 0);
  assert.deepEqual(response.headers, []);
  assert.equal(response.redirected, undefined);
  assert.equal(await text(response), '');
});

test('fetchTransport marks what the platform hides, and only that', async () => {
  const hidden = () => ({
    type: 'opaqueredirect',
    status: 0,
    statusText: '',
    headers: new Headers(),
  });
  const { signal } = new AbortController();
  const request = { url: 'https://opaque.test/', method: 'GET', headers: [], signal };
  const opaque = await fetchTransport({ fetch: async () => hidden() }).fetch({
    ...request,
    redirect: 'manual',
  });
  assert.equal(opaque.opaqueRedirect, true);
  assert.equal(opaque.status, 0);
  const plain = await fetchTransport({ fetch: async () => new Response('ok') }).fetch(request);
  assert.equal('opaqueRedirect' in plain, false);
});

test('fetchTransport resolves the policy per request', async () => {
  const told = [];
  const fetch = async (_url, init) => {
    told.push(init.redirect);
    return new Response('ok');
  };
  const { signal } = new AbortController();
  const request = { url: 'https://policy.test/', method: 'GET', headers: [], signal };
  const manual = fetchTransport({ fetch, redirect: 'manual' });
  const following = fetchTransport({ fetch });
  await manual.fetch(request);
  await manual.fetch({ ...request, redirect: 'follow' });
  await following.fetch(request);
  await following.fetch({ ...request, redirect: 'manual' });
  await following.fetch({ ...request, redirect: 'error' });
  assert.deepEqual(told, ['manual', 'follow', 'follow', 'manual', 'error']);
});
