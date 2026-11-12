import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDev } from './cloudflare-fixture/dev.mjs';

const config = fileURLToPath(
  new URL('../../../examples/cloudflare-computer/wrangler.json', import.meta.url)
);
const remote = { url: process.env.SLICC_CF_COMPUTER_URL, key: process.env.SLICC_CF_COMPUTER_KEY };
const computer = `ports-${crypto.randomUUID()}`;
let dev;

async function json(method, path, body) {
  const joined = `${path}${path.includes('?') ? '&' : '?'}computer=${computer}`;
  const response = await fetch(`${dev.url}${joined}`, {
    method,
    headers: { authorization: `Bearer ${dev.key}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try {
    return { httpStatus: response.status, ...JSON.parse(text) };
  } catch {
    return { httpStatus: response.status, text };
  }
}

const exec = (source) => json('POST', '/exec', { source });

before(async () => {
  dev = await startDev(config, { remote });
});

after(async () => {
  await dev?.stop?.();
});

const skipped = (t) => {
  if (!dev?.skip) return false;
  t.skip(dev.skip);
  return true;
};

describe('kernel port pairs inside the Durable Object', { concurrency: false }, () => {
  test('every tmpfs the kernel mounts by default reads and writes', async (t) => {
    if (skipped(t)) return;
    const listed = await exec('cat /proc/mounts');
    const tmpfs = listed.stdout
      .split('\n')
      .map((line) => line.split(' '))
      .filter((fields) => fields[2] === 'tmpfs')
      .map((fields) => fields[1]);
    assert.ok(tmpfs.includes('/dev/shm'), listed.stdout);
    t.diagnostic(`tmpfs mounts: ${tmpfs.join(', ')}`);
    for (const target of tmpfs) {
      const result = await exec(
        `echo "small on ${target}" > ${target}/small && cat ${target}/small && rm ${target}/small`
      );
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(result.stdout, `small on ${target}\n`);
    }
  });

  test('a file larger than one chunk crosses /dev/shm and the Workspace mount', async (t) => {
    if (skipped(t)) return;
    const size = 3 * 1024 * 1024 + 12345;
    const result = await exec(
      [
        `head -c ${size} /dev/urandom > /dev/shm/big`,
        'cp /dev/shm/big big.bin',
        'cp big.bin /dev/shm/back',
        'sha256sum /dev/shm/big big.bin /dev/shm/back | cut -d" " -f1 | uniq | wc -l',
        'stat -c %s big.bin',
        'rm /dev/shm/big /dev/shm/back',
      ].join(' && ')
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.stdout, `1\n${size}\n`);
    const response = await fetch(`${dev.url}/file?path=/workspace/big.bin&computer=${computer}`, {
      headers: { authorization: `Bearer ${dev.key}` },
    });
    assert.equal((await response.arrayBuffer()).byteLength, size);
  });

  test('an attachKernel client through kernel.connect() runs, takes stdin bytes and reads files', async (t) => {
    if (skipped(t)) return;
    const stdin = randomBytes(200_000);
    const text = `written by the client ${crypto.randomUUID()}\n`;
    const result = await json('POST', '/client', {
      argv: ['sha256sum'],
      stdinBase64: stdin.toString('base64'),
      write: { path: '/workspace/client.txt', text },
      read: '/workspace/client.txt',
    });
    assert.equal(result.status, 0, JSON.stringify(result));
    assert.equal(result.stdout, `${createHash('sha256').update(stdin).digest('hex')}  -\n`);
    assert.equal(result.wrote, text);
    assert.equal(result.read, text);
    const seen = await exec('cat client.txt');
    assert.equal(seen.stdout, text);
  });
});
