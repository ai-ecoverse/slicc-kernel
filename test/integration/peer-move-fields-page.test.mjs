import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const WRITER = [
  'import os, time',
  "os.chdir('/root/rc')",
  "open('f', 'w').write('old')",
  "fd = os.open('f', os.O_RDWR)",
  "open('ready', 'w').close()",
  'errs = {}; n = 0',
  'end = time.time() + 40',
  'while time.time() < end:',
  '    try:',
  "        os.pwrite(fd, b'x', 0); os.fsync(fd)",
  '    except OSError as e:',
  '        errs[e.errno] = errs.get(e.errno, 0) + 1',
  '    n += 1',
  "    if os.path.exists('stop'): break",
  'print(n, errs)',
].join('\n');

test('DO NOT MERGE: #1442 field run for the mover losing its own file', {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  assert.equal(
    (await sh(page, 'rm -rf /root/rc && mkdir -p /root/rc && echo made')).stdout,
    'made\n'
  );
  await page.evaluate((script) => {
    window.writer = window.kernel.run(['python3', '-c', script], { cwd: '/' });
  }, WRITER);
  while (!(await page.evaluate(() => window.opfs.exists('root/rc/ready'))))
    await new Promise((resolve) => setTimeout(resolve, 20));
  const mover = await sh(
    other,
    'cd /root/rc && for i in $(seq 1 60); do for p in "f g" "g f"; do set -- $p; mv $1 $2 2> err || echo "fail $i $1->$2 [$(cat err)] ls=[$(ls -ai | tr "\\n" " ")] slicc=[$(ls -a /.slicc-unlinked 2> /dev/null | tr "\\n" " ")]"; done; done; : > stop; echo moved'
  );
  const writer = await page.evaluate(() => window.writer);
  console.log(`writer: ${writer.stdout.trim()} ${writer.stderr.trim()}`);
  console.log(`mover: ${JSON.stringify(mover)}`);
  const meta = await page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    const out = {};
    for (const { name } of dbs) {
      if (!name?.startsWith('slicc')) continue;
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      for (const store of db.objectStoreNames) {
        const all = await new Promise((resolve) => {
          const r = db.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => resolve([]);
        });
        out[`${name}/${store}`] = all
          .filter((e) => typeof e?.path === 'string' && e.path.startsWith('/root/rc'))
          .map((e) => JSON.stringify(e));
      }
      db.close();
    }
    return out;
  });
  console.log(`meta after: ${JSON.stringify(meta)}`);
  console.log(
    `listing after: ${JSON.stringify(await sh(page, 'ls -ai /root/rc; cat /root/rc/f'))}`
  );
  assert.equal(mover.stderr, '', 'the mover lost its own file');
  assert.match(writer.stdout, /^\d+ \{\}\n$/, 'the writer saw errors');
});
