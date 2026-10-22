import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const MIB = 1024 * 1024;
const SIZE = 64 * MIB;

const READER = [
  'import os, sys, time, zlib',
  'path = sys.argv[1]',
  'size = os.path.getsize(path)',
  'fd = os.open(path, os.O_RDONLY)',
  'want = None',
  'for chunk in (4096, 65536, 1 << 20, 16 << 20):',
  '    count = min(size // chunk, 256 if chunk < (1 << 20) else size // chunk)',
  '    crc = 0',
  '    start = time.perf_counter()',
  '    for i in range(count):',
  '        crc = zlib.crc32(os.pread(fd, chunk, i * chunk), crc)',
  '    took = time.perf_counter() - start',
  '    if count * chunk == size:',
  '        if want is None: want = crc',
  '        assert crc == want, (chunk, crc, want)',
  '    print(f"pread {chunk} {count * chunk / took / 1e6:.0f} MB/s {took / count * 1e6:.0f} us/read")',
  'os.close(fd)',
  'print("whole", zlib.crc32(open(path, "rb").read()) == want)',
].join('\n');

test('positioned reads of a big OPFS file return its bytes at every read size, and report their throughput (#1431)', {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await page.evaluate(async (size) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('tmp', { create: true });
    const file = await dir.getFileHandle('big', { create: true });
    const writable = await file.createWritable();
    const block = new Uint8Array(1 << 20);
    for (let at = 0; at < size; at += block.length) {
      for (let i = 0; i < block.length; i += 4096) block[i] = (at / 4096 + i / 4096) & 0xff;
      await writable.write(block);
    }
    await writable.close();
  }, SIZE);
  await page.evaluate((s) => window.opfs.write('tmp/reader.py', s), READER);
  const r = await page.evaluate(() =>
    window.kernel.run(['python3', '/tmp/reader.py', '/tmp/big'], { cwd: '/' })
  );
  console.log(r.stdout);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /whole True\n$/);
  const calls = await page.evaluate(() =>
    window.kernel.run(['cat', '/proc/sys/kernel/slicc_opfs_calls'], { cwd: '/' })
  );
  assert.equal(calls.status, 0);
  assert.deepEqual(
    await page.evaluate(() => window.kernel.run(['rm', '/tmp/big'], { cwd: '/' })),
    ok('')
  );
});

const LOOP = [
  'import os, sys, time',
  'fd = os.open(sys.argv[1], os.O_RDONLY)',
  'n = 0',
  'while not os.path.exists(sys.argv[2]):',
  '    assert len(os.pread(fd, 1 << 20, 0)) <= 1 << 20',
  '    n += 1',
  'print("reads", n)',
].join('\n');

test("reads through the file's sync access handle don't stop another tab writing the same file (#1431)", {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  await page.evaluate((s) => window.opfs.write('tmp/loop.py', s), LOOP);
  assert.deepEqual(
    await page.evaluate(() =>
      window.kernel.run(
        ['bash', '-c', 'rm -f /tmp/stop; head -c 4194304 /dev/zero > /tmp/shared; echo made'],
        { cwd: '/' }
      )
    ),
    ok('made\n')
  );
  await page.evaluate(() => {
    window.loopRun = window.kernel.run(['python3', '/tmp/loop.py', '/tmp/shared', '/tmp/stop'], {
      cwd: '/',
    });
  });
  const writer = await other.evaluate(() =>
    window.kernel.run(
      [
        'bash',
        '-c',
        'n=0; end=$((SECONDS + 5)); while [ $SECONDS -lt $end ]; do head -c 4194304 /dev/urandom > /tmp/shared || exit 1; n=$((n+1)); done; : > /tmp/stop; echo $n',
      ],
      { cwd: '/' }
    )
  );
  assert.equal(writer.status, 0, writer.stderr);
  const wrote = Number(writer.stdout);
  const loop = await page.evaluate(() => window.loopRun);
  console.log(`peer writes ${wrote}, ${loop.stdout.trim()}`);
  assert.equal(loop.status, 0, loop.stderr);
  assert.ok(wrote > 0);
  assert.match(loop.stdout, /^reads [1-9]\d*\n$/);
});

test('small reads in a tight loop never refuse a writer outside the kernel (#1431, #1017)', {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await page.evaluate(
    (s) => window.opfs.write('tmp/loop.py', s),
    LOOP.replace('1 << 20', '4096').replace('1 << 20', '4096')
  );
  await page.evaluate(() => window.opfs.write('tmp/small', 'x'.repeat(4096)));
  await page.evaluate(() => window.kernel.run(['rm', '-f', '/tmp/stop'], { cwd: '/' }));
  await page.evaluate(() => {
    window.loopRun = window.kernel.run(['python3', '/tmp/loop.py', '/tmp/small', '/tmp/stop'], {
      cwd: '/',
    });
  });
  const refused = await page.evaluate(async () => {
    let refused = 0;
    for (let i = 0; i < 1000; i++) {
      try {
        await window.opfs.write('tmp/small', String(i % 10).repeat(4096));
      } catch {
        refused++;
      }
    }
    await window.opfs.write('tmp/stop', '');
    return refused;
  });
  const loop = await page.evaluate(() => window.loopRun);
  console.log(`outside writes refused ${refused}, ${loop.stdout.trim()}`);
  assert.equal(loop.status, 0, loop.stderr);
  assert.equal(refused, 0);
});
