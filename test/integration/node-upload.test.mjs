import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, fetchTransport, nodeTransport } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const DEADLINE_MS = 30_000;

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

const UPLOAD_PACKAGE = JSON.stringify({
  name: 'streamup',
  slicc: { commands: { streamup: { abi: 'js', module: 'bin/streamup.mjs' } } },
});

const UPLOAD = `export default async function main(ctx) {
  if (ctx.argv[2] === 'string') {
    const r = await ctx.fetch(ctx.argv[1], { method: 'POST', body: 'whole body' });
    await ctx.write(1, r.status + ' ' + (await r.text()));
    return;
  }
  const encoder = new TextEncoder();
  let step = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (step === 0) {
        step = 1;
        controller.enqueue(encoder.encode('first '));
        return;
      }
      if (step === 1) {
        step = 2;
        while (!(await ctx.fs.exists('/tmp/go'))) await new Promise((r) => setTimeout(r, 20));
        controller.enqueue(encoder.encode('second'));
        return;
      }
      controller.close();
    },
  });
  try {
    const r = await ctx.fetch(ctx.argv[1], { method: 'POST', body, duplex: 'half' });
    await ctx.write(1, r.status + ' ' + (await r.text()));
  } catch (err) {
    await ctx.write(1, 'error ' + (err.cause?.code ?? err.code ?? err.message));
  }
}
`;

async function sink(t) {
  let first;
  const seen = new Promise((resolve) => {
    first = resolve;
  });
  const server = createServer((req, res) => {
    if (req.url === '/again') {
      req.resume();
      res.writeHead(307, { location: '/' });
      res.end();
      return;
    }
    const hash = createHash('sha256');
    let length = 0;
    let text = '';
    req.on('data', (chunk) => {
      if (length === 0) first(chunk.toString('latin1'));
      length += chunk.length;
      hash.update(chunk);
      if (length <= 64) text += chunk.toString('latin1');
    });
    req.on('end', () => res.end(`${length} ${hash.digest('hex')} ${length <= 64 ? text : ''}`));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://host.slicc.internal:${server.address().port}/`, seen };
}

async function kernelWith(t, transport) {
  const kernel = await createNodeKernel({ users: 'off', network: { transport } });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-curl', 'wasm-tls-engine']) {
    await install(kernel, name);
  }
  await kernel.writeFile('/node_modules/streamup/package.json', UPLOAD_PACKAGE);
  await kernel.writeFile('/node_modules/streamup/bin/streamup.mjs', UPLOAD);
  const bash = async (script) => (await kernel.run(['bash', '-c', script], { cwd: '/' })).stdout;
  return { kernel, bash };
}

const within = (promise, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} within ${DEADLINE_MS} ms`)), DEADLINE_MS).unref()
    ),
  ]);

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('curl -T of a body over maxRequestBody reaches the server whole through nodeTransport', async (t) => {
  const server = await sink(t);
  const { kernel, bash } = await kernelWith(t, nodeTransport({ hostLoopback: true }));
  const body = randomBytes(64 * 1024 * 1024 + 4096);
  await kernel.writeFile('/tmp/big.bin', body);
  const out = await bash(`curl -sS -T /tmp/big.bin -w ' %{http_code}' ${server.url}`);
  assert.equal(out, `${body.length} ${sha(body)}  200`);
});

test('a chunked upload streams: the server sees its first part before the program writes the rest', async (t) => {
  const server = await sink(t);
  const { kernel, bash } = await kernelWith(t, nodeTransport({ hostLoopback: true }));
  const running = bash(
    `{ printf 'first '; until [ -e /tmp/go ]; do sleep 0.02; done; printf second; } | curl -sS -T - -w ' %{http_code}' ${server.url}`
  );
  running.catch(() => undefined);
  assert.equal(await within(server.seen, 'the first part'), 'first ');
  await kernel.writeFile('/tmp/go', '');
  const body = Buffer.from('first second');
  assert.equal(await running, `${body.length} ${sha(body)} first second 200`);
});

test('ctx.fetch with a stream body and duplex half streams it to the server', async (t) => {
  const server = await sink(t);
  const { kernel } = await kernelWith(t, nodeTransport({ hostLoopback: true }));
  const running = kernel.run(['streamup', server.url], { cwd: '/' });
  running.catch(() => undefined);
  assert.equal(await within(server.seen, 'the first part'), 'first ');
  await kernel.writeFile('/tmp/go', '');
  const body = Buffer.from('first second');
  assert.equal((await running).stdout, `200 ${body.length} ${sha(body)} first second`);
});

test('ctx.fetch with a string body on a streaming transport sends it whole, so a 307 resends it', async (t) => {
  const server = await sink(t);
  const { kernel } = await kernelWith(t, nodeTransport({ hostLoopback: true }));
  const r = await kernel.run(['streamup', `${server.url}again`, 'string'], { cwd: '/' });
  const body = Buffer.from('whole body');
  assert.equal(r.stdout, `200 ${body.length} ${sha(body)} whole body`);
});

test('a whole-body transport still answers 413 over its maxRequestBody, and streamingBodies lifts it', async (t) => {
  const server = await sink(t);
  const body = randomBytes(4096);
  const whole = await kernelWith(t, fetchTransport({ maxRequestBody: 1024, redirect: 'manual' }));
  await whole.kernel.writeFile('/tmp/body.bin', body);
  assert.match(
    await whole.bash(`curl -sS -T /tmp/body.bin -w ' %{http_code}' ${server.url}`),
    /request body over 1024 bytes\n 413$/
  );
  const streaming = await kernelWith(
    t,
    fetchTransport({ maxRequestBody: 1024, redirect: 'manual', streamingBodies: true })
  );
  await streaming.kernel.writeFile('/tmp/body.bin', body);
  assert.equal(
    await streaming.bash(`curl -sS -T /tmp/body.bin -w ' %{http_code}' ${server.url}`),
    `${body.length} ${sha(body)}  200`
  );
});
