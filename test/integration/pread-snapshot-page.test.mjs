import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const M = 1024 * 1024;
const shown =
  'def show(label, b):\n    print(label, len(b), "".join(sorted(set(b.decode()))), flush=True)';

const reader = [
  'import os, time',
  "d = '/home/ps/'",
  "p = d + 'f'",
  'M = 1024 * 1024',
  shown,
  'def touch(name):',
  '    os.close(os.open(d + name, os.O_WRONLY | os.O_CREAT))',
  'def wait(name):',
  '    while not os.path.exists(d + name): pass',
  'fd = os.open(p, os.O_RDONLY)',
  "show('first', os.pread(fd, 4096, 0))",
  'time.sleep(0.15)',
  "show('again', os.pread(fd, 4096, M))",
  "show('eof', os.pread(fd, 4096, 8 * M - 100))",
  "show('past', os.pread(fd, 10, 8 * M))",
  'w = os.open(p, os.O_WRONLY)',
  "os.pwrite(w, b'b' * 4096, 2 * M)",
  'os.close(w)',
  'time.sleep(0.15)',
  "show('own', os.pread(fd, 4096, 2 * M))",
  "touch('go-peer1')",
  "wait('peer-done1')",
  'time.sleep(0.15)',
  "show('peer', os.pread(fd, 4096, 6 * M))",
  "touch('go-peer2')",
  "wait('peer-done2')",
  'more = os.open(p, os.O_RDONLY)',
  'time.sleep(0.15)',
  "show('peer-grown', os.pread(more, 4096, 8 * M))",
  'os.close(more)',
  'os.close(fd)',
].join('\n');

const peer = [
  'import os',
  "d = '/home/ps/'",
  'M = 1024 * 1024',
  'def wait(name):',
  '    while not os.path.exists(d + name): pass',
  "wait('go-peer1')",
  "fd = os.open(d + 'f', os.O_WRONLY)",
  "os.pwrite(fd, b'e' * M, 6 * M)",
  'os.close(fd)',
  "os.close(os.open(d + 'peer-done1', os.O_WRONLY | os.O_CREAT))",
  "wait('go-peer2')",
  "fd = os.open(d + 'f', os.O_WRONLY | os.O_APPEND)",
  "os.write(fd, b'f' * M)",
  'os.close(fd)',
  "os.close(os.open(d + 'peer-done2', os.O_WRONLY | os.O_CREAT))",
  "print('peer done')",
].join('\n');

const ROUNDS = 3;
const outside = [
  'import os, sys',
  "d = '/home/ps/'",
  shown,
  `for i in range(${ROUNDS}):`,
  "    g = os.open(d + 'g%d' % i, os.O_RDONLY)",
  "    print('ready', i, flush=True)",
  '    sys.stdin.readline()',
  "    show('outside', os.pread(g, 4096, 0))",
  '    os.close(g)',
].join('\n');

const py = (tab, script) =>
  tab.evaluate((s) => window.kernel.run(['python3', '-c', s], { cwd: '/' }), script);

test('positioned reads of one OPFS file return the current bytes after writes in this tab, outside the kernel and in a peer tab whose notices this tab never hears, and stop short at EOF (#1626)', {
  timeout: 600_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t, {
    worker: '/blind-worker.js?path=%2Fhome%2Fps%2Ff',
  });
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await installPackage(page, 'wasm-coreutils');
  const other = await peerTab(page);
  assert.deepEqual(await bash('rm -rf /home/ps && mkdir -p /home/ps', { cwd: '/' }), ok());
  const made = [`open('/home/ps/f', 'wb').write(b'a' * ${8 * M})`];
  for (let i = 0; i < ROUNDS; i++) made.push(`open('/home/ps/g${i}', 'wb').write(b'a' * ${M})`);
  assert.deepEqual(await py(page, `${made.join('\n')}\nprint('made')`), ok('made\n'));

  await page.evaluate((s) => window.terminal(['python3', '-c', s], { cwd: '/' }), outside);
  const screen = await page.evaluate(
    async (rounds, M) => {
      for (let i = 0; i < rounds; i++) {
        while (!window.screen.screen.includes(`ready ${i}`)) {
          if (window.screen.status !== null) break;
          await new Promise((r) => setTimeout(r, 2));
        }
        await window.opfs.write(`home/ps/g${i}`, 'c'.repeat(M));
        window.term.write(new TextEncoder().encode('\n'));
      }
      while (window.screen.status === null) await new Promise((r) => setTimeout(r, 10));
      return { screen: window.screen.screen, status: window.screen.status };
    },
    ROUNDS,
    M
  );
  const lines = screen.screen.split(/\r?\n/).filter((line) => line.startsWith('outside '));
  assert.deepEqual(
    { status: screen.status, lines },
    {
      status: 0,
      lines: Array(ROUNDS).fill('outside 4096 c'),
    },
    screen.screen
  );

  await other.evaluate((s) => {
    window.preadPeer = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, peer);
  assert.deepEqual(
    await py(page, reader),
    ok(
      [
        'first 4096 a',
        'again 4096 a',
        'eof 100 a',
        'past 0 ',
        'own 4096 b',
        'peer 4096 e',
        'peer-grown 4096 f',
        '',
      ].join('\n')
    )
  );
  assert.deepEqual(await other.evaluate(() => window.preadPeer), ok('peer done\n'));
});
