import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const ATTEMPTS = [
  'echo new > /opt/agent/a.txt',
  'echo more >> /opt/agent/a.txt',
  'touch /opt/agent/b.txt',
  'mkdir /opt/agent/d',
  'rm /opt/agent/a.txt',
  'rm -rf /opt',
  'mv /opt/agent/a.txt /tmp/a.txt',
  'mv /tmp/x.txt /opt/agent/x.txt',
  'chmod 777 /opt/agent/a.txt',
  'ln -s /tmp/x.txt /opt/agent/l',
  'ln -sf /opt/agent/a.txt /tmp/via && echo through > /tmp/via',
  'ln -sfn /opt/agent /tmp/dir && echo through > /tmp/dir/a.txt',
  'truncate -s 0 /opt/agent/a.txt',
];

test('a protected prefix is read-only for every process, root included, and for a client, through symlinks too', async (t) => {
  const { page, bash, run } = await booted(chrome, t, { protect: { paths: ['/opt/agent'] } });
  await page.evaluate(() => window.opfs.write('opt/agent/a.txt', 'kept\n'));
  await bash('echo x > /tmp/x.txt', { cwd: '/' });
  for (const script of ATTEMPTS) {
    const r = await bash(`${script}; echo "rc=$?"`, { cwd: '/' });
    assert.notEqual(r.stdout.trim().split('\n').pop(), 'rc=0', `${script}: ${JSON.stringify(r)}`);
  }
  assert.match(
    (await bash('echo new > /opt/agent/a.txt', { cwd: '/' })).stderr,
    /Read-only file system/
  );
  const direct = await run(['jstest', 'files', 'big.bin'], { cwd: '/opt/agent' });
  assert.notEqual(direct.status, 0, JSON.stringify(direct));
  const linked = await run(['jstest', 'files', '/tmp/via'], { cwd: '/' });
  assert.notEqual(linked.status, 0, JSON.stringify(linked));
  const client = await page.evaluate(async () => {
    const c = await window.attachKernel(await window.kernel.connect());
    const tried = await c.fs.writeFile('/opt/agent/c.txt', 'x').then(
      () => 'written',
      (e) => e.code
    );
    const free = await c.fs.writeFile('/tmp/c.txt', 'x').then(() => 'written');
    c.close();
    return { tried, free };
  });
  assert.deepEqual(client, { tried: 'EROFS', free: 'written' });
  assert.deepEqual(
    await bash('cat /opt/agent/a.txt; ls /opt/agent', { cwd: '/' }),
    ok('kept\na.txt\n')
  );
  assert.equal(await page.evaluate(() => window.opfs.read('opt/agent/a.txt')), 'kept\n');
  assert.deepEqual(
    await bash('echo free > /tmp/free.txt && cat /tmp/free.txt', { cwd: '/' }),
    ok('free\n')
  );
  await page.evaluate(() => window.opfs.write('opt/agent/page.txt', 'the page writes\n'));
  assert.deepEqual(await bash('cat /opt/agent/page.txt', { cwd: '/' }), ok('the page writes\n'));
  const refused = await page.evaluate(() =>
    window
      .secondKernel({ protect: { paths: ['/opt'], writer: () => true } }, 'third')
      .catch((e) => e.message)
  );
  assert.match(refused, /protect\.writer needs the process tag \(#405\)/);
});
