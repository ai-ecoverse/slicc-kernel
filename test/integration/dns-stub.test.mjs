import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, memoryRoot } from '../../dist/node.js';
import { fakeUplink } from '../../dist/testing.js';

const fixtures = new URL('./fixtures/', import.meta.url);
const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const TIMEOUT = { timeout: 120_000 };
const STUB = '127.0.0.53';

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

async function fixture(kernel, name) {
  const dir = new URL(`${name}/`, fixtures);
  for (const file of ['package.json', `bin/${name}.wasm`]) {
    await kernel.writeFile(`/node_modules/${name}/${file}`, await readFile(new URL(file, dir)));
  }
}

function questionEnd(q) {
  let i = 12;
  while (q[i]) i += q[i] + 1;
  return i + 5;
}

function mxReply(query, extra = 0) {
  const end = questionEnd(query);
  const name = [0xc0, 0x0c];
  const mx = [0, 10, 4, ...new TextEncoder().encode('mail'), 0xc0, 0x0c];
  const answer = (rdata, type = 15) => [
    ...name,
    0,
    type,
    0,
    1,
    0,
    0,
    1,
    44,
    0,
    rdata.length,
    ...rdata,
  ];
  const records = [answer(mx)];
  for (let i = 0; i < extra; i++) records.push(answer(Array(200).fill(97), 16));
  return new Uint8Array([
    query[0],
    query[1],
    0x81,
    0x80,
    0,
    1,
    0,
    records.length,
    0,
    0,
    0,
    0,
    ...query.slice(12, end),
    ...records.flat(),
  ]);
}

function dohTransport(answer = (q) => ({ status: 200, body: mxReply(q) })) {
  const asked = [];
  return {
    asked,
    traits: { manualRedirects: true, encodedBodies: true, maxRequestBody: 1 << 20 },
    async fetch(req) {
      asked.push({
        url: req.url,
        method: req.method,
        type: req.headers.find(([k]) => k === 'content-type')?.[1],
        id: (req.body[0] << 8) | req.body[1],
      });
      const { status, body } = answer(req.body);
      return {
        status,
        statusText: status === 200 ? 'OK' : 'Unavailable',
        headers: [['content-type', status === 200 ? 'application/dns-message' : 'text/plain']],
        body: (async function* () {
          yield body;
        })(),
        cancel: async () => {},
      };
    },
  };
}

async function boot(t, options = {}) {
  const { users = 'off', ...rest } = options;
  const kernel = await createNodeKernel({ users, ...rest });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  await fixture(kernel, 'dnstest');
  await fixture(kernel, 'udptest');
  const sh = (script, user) =>
    kernel.run(['bash', '-c', script], { cwd: '/', ...(user ? { user } : {}) });
  const dns = async (...args) => {
    const r = await kernel.run(['dnstest', ...args], { cwd: '/' });
    return r.stdout + r.stderr;
  };
  return { kernel, sh, dns };
}

test(
  'the kernel writes /etc/resolv.conf naming its stub at boot, as root 0644, and keeps one root wrote (#1244)',
  TIMEOUT,
  async (t) => {
    const root = memoryRoot();
    const first = await boot(t, { users: 'enforce', root });
    await first.kernel.users.add({ name: 'cone' });
    assert.deepEqual(
      await first.sh("cat /etc/resolv.conf && stat -c '%U %G %a' /etc/resolv.conf"),
      {
        status: 0,
        stdout: 'nameserver 127.0.0.53\noptions edns0\nroot root 644\n',
        stderr: '',
      }
    );
    const denied = await first.sh('echo nameserver 10.0.0.1 > /etc/resolv.conf', 'cone');
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /Permission denied/);
    assert.equal((await first.sh('echo nameserver 100.100.100.100 > /etc/resolv.conf')).status, 0);
    await first.kernel.terminate();
    const second = await boot(t, { users: 'enforce', root });
    assert.equal((await second.sh('cat /etc/resolv.conf')).stdout, 'nameserver 100.100.100.100\n');
    assert.equal((await second.sh('rm /etc/resolv.conf')).status, 0);
    await second.kernel.terminate();
    const third = await boot(t, { users: 'enforce', root });
    assert.equal(
      (await third.sh('cat /etc/resolv.conf')).stdout,
      'nameserver 127.0.0.53\noptions edns0\n'
    );
  }
);

test(
  "the stub answers the kernel's names over UDP and TCP, authoritatively, from any loopback address (#1244)",
  TIMEOUT,
  async (t) => {
    const uplink = fakeUplink({ names: { 'laptop.slicc.internal': ['100.64.0.7'] } });
    const { dns, sh } = await boot(t, { network: { uplink } });
    for (const via of ['udp', 'tcp']) {
      assert.equal(
        await dns(via, STUB, 'host.slicc.internal', 'A'),
        'id ok rcode 0 aa 1 tc 0 ra 1 an 1 ar 0\nhost.slicc.internal 30 1 10.0.2.2\n',
        via
      );
      assert.equal(
        await dns(via, STUB, 'laptop.slicc.internal', 'A'),
        'id ok rcode 0 aa 1 tc 0 ra 1 an 1 ar 0\nlaptop.slicc.internal 30 1 100.64.0.7\n',
        via
      );
      assert.equal(
        await dns(via, STUB, 'nope.slicc.internal', 'A'),
        'id ok rcode 3 aa 1 tc 0 ra 1 an 0 ar 0\n',
        via
      );
    }
    assert.equal(
      await dns('udp', '127.0.0.1', 'slicc', 'A'),
      'id ok rcode 0 aa 0 tc 0 ra 1 an 1 ar 0\nslicc 30 1 127.0.1.1\n'
    );
    assert.equal(
      await dns('udp', STUB, 'localhost', 'AAAA', 'edns'),
      'id ok rcode 0 aa 1 tc 0 ra 1 an 1 ar 1\nlocalhost 30 28 ::1\n'
    );
    assert.equal(
      await dns('udp', STUB, 'host.slicc.internal', 'MX'),
      'id ok rcode 0 aa 1 tc 0 ra 1 an 0 ar 0\n'
    );
    assert.equal(
      await dns('udp', STUB, '2.2.0.10.in-addr.arpa', 'PTR'),
      'id ok rcode 0 aa 1 tc 0 ra 1 an 1 ar 0\n2.2.0.10.in-addr.arpa 30 12 host.slicc.internal\n'
    );
    assert.equal(
      await dns('tcp2', STUB, 'host.slicc.internal', 'A'),
      'id ok rcode 0 aa 1 tc 0 ra 1 an 1 ar 0\nhost.slicc.internal 30 1 10.0.2.2\n'
    );
    assert.equal((await sh("echo '10.0.0.9 db' >> /etc/hosts")).status, 0);
    assert.equal(
      await dns('udp', STUB, 'db', 'A'),
      'id ok rcode 0 aa 0 tc 0 ra 1 an 1 ar 0\ndb 30 1 10.0.0.9\n'
    );
    assert.equal(
      await dns('udp', STUB, '9.0.0.10.in-addr.arpa', 'PTR'),
      'id ok rcode 0 aa 1 tc 0 ra 1 an 1 ar 0\n9.0.0.10.in-addr.arpa 30 12 db\n'
    );
  }
);

test(
  'other names and types go to DNS over HTTPS through the transport, with id 0; network.doh picks the endpoint or turns it off (#1244)',
  TIMEOUT,
  async (t) => {
    const transport = dohTransport();
    const { dns } = await boot(t, { network: { transport } });
    assert.equal(
      await dns('udp', STUB, 'example.com', 'MX'),
      'id ok rcode 0 aa 0 tc 0 ra 1 an 1 ar 0\nexample.com 300 15 10 mail.example.com\n'
    );
    assert.equal(
      await dns('tcp', STUB, 'example.com', 'A'),
      'id ok rcode 0 aa 0 tc 0 ra 1 an 1 ar 0\nexample.com 300 15 10 mail.example.com\n'
    );
    assert.deepEqual(transport.asked[0], {
      url: 'https://cloudflare-dns.com/dns-query',
      method: 'POST',
      type: 'application/dns-message',
      id: 0,
    });
    assert.equal(transport.asked.length, 2);

    const other = dohTransport();
    const custom = await boot(t, { network: { transport: other, doh: 'https://dns.example/q' } });
    assert.match(await custom.dns('udp', STUB, 'example.com', 'MX'), /^id ok rcode 0 /);
    assert.equal(other.asked[0].url, 'https://dns.example/q');

    const none = dohTransport();
    const off = await boot(t, { network: { transport: none, doh: false } });
    assert.equal(
      await off.dns('udp', STUB, 'example.com', 'MX'),
      'id ok rcode 2 aa 0 tc 0 ra 1 an 0 ar 0\n'
    );
    assert.equal(
      await off.dns('udp', STUB, 'host.slicc.internal', 'A'),
      'id ok rcode 0 aa 1 tc 0 ra 1 an 1 ar 0\nhost.slicc.internal 30 1 10.0.2.2\n'
    );
    assert.equal(none.asked.length, 0);

    const down = await boot(t, {
      network: { transport: dohTransport(() => ({ status: 503, body: new Uint8Array() })) },
    });
    assert.equal(
      await down.dns('udp', STUB, 'example.com', 'MX'),
      'id ok rcode 2 aa 0 tc 0 ra 1 an 0 ar 0\n'
    );
  }
);

test(
  'a forwarded answer too big for UDP comes back truncated, whole with EDNS or over TCP (#1244)',
  TIMEOUT,
  async (t) => {
    const transport = dohTransport((q) => ({ status: 200, body: mxReply(q, 4) }));
    const { dns } = await boot(t, { network: { transport } });
    assert.equal(
      await dns('udp', STUB, 'big.example', 'MX'),
      'id ok rcode 0 aa 0 tc 1 ra 1 an 0 ar 0\n'
    );
    assert.match(
      await dns('udp', STUB, 'big.example', 'MX', 'edns'),
      /^id ok rcode 0 aa 0 tc 0 ra 1 an 5 /
    );
    assert.match(
      await dns('tcp', STUB, 'big.example', 'MX'),
      /^id ok rcode 0 aa 0 tc 0 ra 1 an 5 /
    );
  }
);

test(
  'a program that binds UDP port 53 first gets its datagrams, not the stub (#1244)',
  TIMEOUT,
  async (t) => {
    const { sh } = await boot(t);
    const got = await sh('udptest serve 53 1 & sleep 0.5; udptest client 127.0.0.1 53 hello; wait');
    assert.deepEqual(got.stdout.trim().split('\n').sort(), [
      'reply HELLO from 127.0.0.1:53',
      'served 1',
    ]);
  }
);

test(
  'at most 64 UDP questions wait on the forwarder at once; more are dropped, as by a full receive queue (#1263 review)',
  TIMEOUT,
  async (t) => {
    const held = [];
    let asked = 0;
    const transport = {
      traits: { manualRedirects: true, encodedBodies: true, maxRequestBody: 1 << 20 },
      fetch(req) {
        asked++;
        return new Promise((resolve, reject) => {
          req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
          held.push(() =>
            resolve({
              status: 200,
              statusText: 'OK',
              headers: [['content-type', 'application/dns-message']],
              body: (async function* () {
                yield mxReply(req.body);
              })(),
              cancel: async () => {},
            })
          );
        });
      },
    };
    const { dns } = await boot(t, { network: { transport } });
    const until = async (done) => {
      for (const end = Date.now() + 20_000; !done() && Date.now() < end; ) {
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    assert.equal(await dns('flood', STUB, 'example.com', 'MX', '200'), 'sent 200\n');
    await until(() => asked >= 64);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(asked, 64);
    for (const release of held.splice(0)) release();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(asked, 64);
    const next = dns('udp', STUB, 'example.com', 'MX');
    await until(() => held.length > 0);
    for (const release of held.splice(0)) release();
    assert.equal(
      await next,
      'id ok rcode 0 aa 0 tc 0 ra 1 an 1 ar 0\nexample.com 300 15 10 mail.example.com\n'
    );
  }
);

test(
  'a TCP client that sends questions but never reads the answers is closed after 10 s (#1263 review)',
  TIMEOUT,
  async (t) => {
    const { dns } = await boot(t);
    const got = await dns('stall', STUB, 'host.slicc.internal', 'A', '12');
    assert.match(got, /^wrote \d+ got \d+ closed\n$/, got);
    assert.equal(
      await dns('tcp', STUB, 'host.slicc.internal', 'A'),
      'id ok rcode 0 aa 1 tc 0 ra 1 an 1 ar 0\nhost.slicc.internal 30 1 10.0.2.2\n'
    );
  }
);
