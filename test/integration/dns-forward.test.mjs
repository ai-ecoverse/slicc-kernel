import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';
import { fakeUplink } from '../../dist/testing.js';
import { installPackage, shown } from './cf/async-wasi-harness.mjs';
import { dnsAnswer } from './cf/cloudflare-fixture/dns-answer.js';

const DOH = 'https://dns.example/q';
const TIMEOUT = { timeout: 120_000 };

function dohTransport(asked) {
  return {
    traits: { manualRedirects: true, encodedBodies: true, maxRequestBody: 1 << 20 },
    async fetch(req) {
      asked.push(req.url);
      return {
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'application/dns-message']],
        body: (async function* () {
          yield dnsAnswer(req.body);
        })(),
        cancel: async () => {},
      };
    },
  };
}

function exitUplink(names = {}) {
  const served = [];
  const uplink = fakeUplink({
    names,
    routes: { prefixes: [], exit: true },
    peers: {
      '104.18.1.1:443': async (server) => {
        served.push('104.18.1.1');
        server.write(new TextEncoder().encode('hello\n'));
        server.end();
      },
    },
  });
  return { uplink, served };
}

async function kernels(t, uplinkOf) {
  const out = [];
  for (const mode of [{}, { blocking: 'async', emscripten: 'kernel' }]) {
    const asked = [];
    const { uplink, served } = uplinkOf();
    const kernel = await createNodeKernel({
      ...mode,
      network: { transport: dohTransport(asked), uplink, doh: DOH },
    });
    t.after(() => kernel.terminate());
    await installPackage(kernel, 'wasix-bind');
    await installPackage(kernel, 'wasix-python');
    out.push({
      run: async (argv) => shown(await kernel.run(argv, { cwd: '/' })),
      asked,
      uplink,
      served,
      name: mode.blocking ?? 'sync',
    });
  }
  return out;
}

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

const CONNECT = [
  'python',
  '-c',
  'import socket\nprint(socket.getaddrinfo("www.aem.live", 443, socket.AF_INET, socket.SOCK_STREAM)[0][4])\ns = socket.create_connection(("www.aem.live", 443))\nprint(s.recv(16))\ntry:\n  socket.getaddrinfo("nope.aem.live", 443)\nexcept socket.gaierror as e:\n  print("gaierror", e.strerror)',
];

test(
  "with an exit uplink that has no names of its own, the stub forwards outside names, and getaddrinfo resolves them through the forwarder for the uplink's dial",
  TIMEOUT,
  async (t) => {
    for (const k of await kernels(t, () => exitUplink())) {
      const dug = await k.run(['dig', '+noall', '+answer', 'www.aem.live']);
      assert.deepEqual(
        dug,
        ok(
          'www.aem.live.\t\t300\tIN\tCNAME\taem.live.cdn.cloudflare.net.\naem.live.cdn.cloudflare.net. 60\tIN\tA\t104.18.1.1\naem.live.cdn.cloudflare.net. 60\tIN\tA\t104.18.2.2\n'
        ),
        k.name
      );
      assert.deepEqual(
        await k.run(['host', 'www.aem.live']),
        ok(
          'www.aem.live is an alias for aem.live.cdn.cloudflare.net.\naem.live.cdn.cloudflare.net has address 104.18.1.1\naem.live.cdn.cloudflare.net has address 104.18.2.2\naem.live.cdn.cloudflare.net has IPv6 address 2606:4700::6812:101\n'
        ),
        k.name
      );
      assert.deepEqual(
        await k.run(CONNECT),
        ok("('104.18.1.1', 443)\nb'hello\\n'\ngaierror no address associated with hostname.\n"),
        k.name
      );
      assert.deepEqual(k.served, ['104.18.1.1'], k.name);
      assert.deepEqual(
        k.uplink.dialled.map(({ host, port }) => `${host}:${port}`),
        ['104.18.1.1:443'],
        k.name
      );
      assert.ok(k.asked.length > 0 && k.asked.every((url) => url === DOH), k.name);
    }
  }
);

test(
  "the stub still answers the uplink's own names itself, and an uplink without resolve forwards every outside name",
  TIMEOUT,
  async (t) => {
    const own = () => exitUplink({ 'laptop.tail.ts.net': { addresses: ['100.64.0.7'], ttl: 30 } });
    for (const k of await kernels(t, own)) {
      assert.deepEqual(
        await k.run(['dig', '+noall', '+answer', 'laptop.tail.ts.net']),
        ok('laptop.tail.ts.net.\t30\tIN\tA\t100.64.0.7\n'),
        k.name
      );
      assert.deepEqual(k.asked, [], k.name);
      assert.deepEqual(
        await k.run(['dig', '+short', 'www.aem.live']),
        ok('aem.live.cdn.cloudflare.net.\n104.18.1.1\n104.18.2.2\n'),
        k.name
      );
    }
    const bare = () => {
      const made = exitUplink();
      delete made.uplink.resolve;
      return made;
    };
    for (const k of await kernels(t, bare)) {
      assert.deepEqual(
        await k.run(CONNECT),
        ok("('104.18.1.1', 443)\nb'hello\\n'\ngaierror no address associated with hostname.\n"),
        k.name
      );
      assert.equal((await k.run(['host', '-t', 'A', 'www.aem.live'])).status, 0, k.name);
    }
  }
);
