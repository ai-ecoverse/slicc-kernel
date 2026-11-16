import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fetchTransport } from '../../../dist/node.js';
import { both, kernelPair, skip } from './async-wasi-harness.mjs';

const FIXTURE = new URL('../fixtures/hostcall/', import.meta.url);
const FILES = ['package.json', 'bin/hostcall.wasm', 'host/hostcall-host.mjs', 'host/sync-only.mjs'];

async function install(kernel) {
  for (const file of FILES) {
    await kernel.writeFile(
      `/node_modules/hostcall/${file}`,
      await readFile(new URL(file, FIXTURE))
    );
  }
}

function gateway() {
  const seen = [];
  const transport = fetchTransport({
    redirect: 'manual',
    fetch: async (url, init) => {
      seen.push(`${init.method} ${url} ${new Headers(init.headers).get('authorization')}`);
      return new Response(`answered ${url}`);
    },
  });
  return { seen, transport };
}

const request = (value) => ['hostcall', JSON.stringify(value)];

test('an imports module runs on the async host through createAsyncImports, as createImports does on blocking workers', {
  skip,
}, async (t) => {
  const { seen, transport } = gateway();
  const pair = await kernelPair(t, install, { network: { transport } });
  for (const [ask, value] of [
    [{ op: 'echo' }, { argv: ['hostcall', '{"op":"echo"}'], cwd: '/' }],
    [{ op: 'exists', path: '/node_modules/hostcall/package.json' }, true],
    [
      {
        op: 'http',
        url: 'https://api.example.test/repos/cli/cli',
        headers: [['authorization', 'token PLACEHOLDER']],
      },
      { status: 200, body: 'answered https://api.example.test/repos/cli/cli' },
    ],
  ]) {
    const { sync, async } = await both(pair, request(ask), { cwd: '/' });
    assert.deepEqual(async, sync);
    assert.deepEqual(JSON.parse(async.stdout), { ok: true, value });
  }
  assert.deepEqual(seen, [
    'GET https://api.example.test/repos/cli/cli token PLACEHOLDER',
    'GET https://api.example.test/repos/cli/cli token PLACEHOLDER',
  ]);
  const ran = await both(pair, request({ op: 'run', argv: request({ op: 'echo' }) }), { cwd: '/' });
  assert.deepEqual(ran.async, ran.sync);
  assert.equal(JSON.parse(ran.async.stdout).value.status, 0);
});

test('on the async host, a module without createAsyncImports is refused with 126 and a message', {
  skip,
}, async (t) => {
  const pair = await kernelPair(t, install);
  const { sync, async } = await both(pair, ['hostcall-sync', '{}'], { cwd: '/' });
  assert.equal(sync.status, 0);
  assert.deepEqual(async, {
    status: 126,
    stdout: '',
    stderr:
      'the imports module exports no createAsyncImports function, which the async process host calls\n',
  });
});
