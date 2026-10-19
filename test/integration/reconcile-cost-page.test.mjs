import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const DIRS = 4;
const PER_DIR = 300;
const GONE = 60;

const reboot = async (page) => {
  await page.reload();
  await page.until(() => typeof window.boot === 'function');
  await page.evaluate(() => window.boot({}));
  const r = await page.evaluate(() =>
    window.kernel.run(['bash', '-c', 'read -r n < /proc/sys/kernel/slicc_opfs_calls; echo $n'], {
      cwd: '/',
    })
  );
  return Number(r.stdout);
};

const raw = (page, op, dir, names) =>
  page.evaluate(
    async (op, dir, names) => {
      let at = await navigator.storage.getDirectory();
      for (const part of dir.split('/')) at = await at.getDirectoryHandle(part, { create: true });
      for (const name of names) {
        if (op === 'remove') await at.removeEntry(name, { recursive: true });
        else if (op === 'dir') await at.getDirectoryHandle(name, { create: true });
        else
          await (await at.getFileHandle(name, { create: true }))
            .createWritable()
            .then((w) => w.close());
      }
    },
    op,
    dir,
    names
  );

const names = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `f${from + i}`);

test('a reload with a thousand sidecar records makes OPFS calls by directory, not by record, and still drops the stale ones (#1116)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(await bash('mkdir -p /home/rc && echo made', { cwd: '/' }), ok('made\n'));
  const base = await reboot(page);
  const shell = (s) =>
    page.evaluate((s) => window.kernel.run(['bash', '-c', s], { cwd: '/home/rc' }), s);
  assert.deepEqual(
    await shell(
      `for d in $(seq 0 ${DIRS - 1}); do mkdir -p d$d && (cd d$d && for i in $(seq ${PER_DIR}); do : > f$i; done); done && chmod 600 d*/f* && mkdir l && ln -s ../d1/f1 l/s && echo made`
    ),
    ok('made\n')
  );
  await raw(page, 'remove', 'home/rc/d0', names(1, GONE));
  await raw(page, 'remove', 'home/rc', ['l']);
  const loaded = await reboot(page);
  console.log(
    `OPFS calls at boot: ${base} with no records, ${loaded} with ${DIRS * PER_DIR} records`
  );
  assert.ok(base > 0, 'the kernel counts its OPFS calls');
  assert.ok(
    loaded - base <= 100,
    `${DIRS * PER_DIR} records in ${DIRS} directories cost ${loaded - base} more OPFS calls at boot`
  );
  await raw(page, 'file', 'home/rc/d0', names(1, GONE));
  await raw(page, 'dir', 'home/rc', ['l']);
  const modes = `stat -c %a ${names(1, GONE)
    .map((n) => `d0/${n}`)
    .join(' ')} | sort | uniq -c | while read -r n m; do echo "$m x$n"; done`;
  assert.deepEqual(
    await shell(
      `${modes}; stat -c %a d0/f${GONE + 1} d${DIRS - 1}/f${PER_DIR}; [ -L l/s ] && echo link || echo nolink`
    ),
    ok(`644 x${GONE}\n600\n600\nnolink\n`)
  );
});

test('a reload while another tab shares the root keeps the sidecar records, even those whose files are gone (#1116, #953)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash(
      'mkdir -p /home/rp && cd /home/rp && : > f1 && : > f2 && chmod 600 f1 f2 && echo made',
      {
        cwd: '/',
      }
    ),
    ok('made\n')
  );
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await other.evaluate(() => window.boot({}));
  await raw(page, 'remove', 'home/rp', ['f1']);
  await reboot(page);
  await raw(page, 'file', 'home/rp', ['f1']);
  assert.deepEqual(
    await page.evaluate(() =>
      window.kernel.run(
        ['bash', '-c', 'cat /proc/sys/kernel/slicc_shared_root; stat -c %a f1 f2'],
        {
          cwd: '/home/rp',
        }
      )
    ),
    ok('1\n600\n600\n')
  );
});
