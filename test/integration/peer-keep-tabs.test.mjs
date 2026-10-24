import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { PEER_WORKER, peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const steer = (tab, msg) =>
  tab.evaluate(
    (m) =>
      new Promise((resolve) => {
        const channel = new BroadcastChannel('pause-control');
        const seq = Math.random();
        channel.onmessage = ({ data }) => {
          if (data?.done !== seq) return;
          channel.close();
          resolve();
        };
        channel.postMessage({ id: 'h', seq, ...m });
      }),
    msg
  );

const HOLDER = (dir) =>
  [
    'import os, time',
    `fd = os.open('${dir}/f', os.O_RDWR)`,
    `open('${dir}/opened', 'w').close()`,
    `while not os.path.exists('${dir}/go'): time.sleep(0.02)`,
    'out = []',
    'try:',
    '    out.append(os.pread(fd, 16, 0).decode().strip())',
    '    os.ftruncate(fd, 0)',
    "    os.pwrite(fd, b'kept', 0)",
    '    os.fsync(fd)',
    '    out.append(os.pread(fd, 16, 0).decode().strip())',
    '    os.close(fd)',
    'except OSError as e:',
    "    out.append(f'errno {e.errno}')",
    "print(' '.join(out))",
  ].join('\n');

async function setup(t, dir) {
  const { page } = await booted(chrome, t, { worker: '/rename/pause-worker.js?id=h' });
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  assert.deepEqual(
    await sh(page, `rm -rf ${dir} && mkdir -p ${dir} && echo old > ${dir}/f && echo made`),
    ok('made\n')
  );
  await page.evaluate((s) => {
    window.holder = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, HOLDER(dir));
  while (!(await page.evaluate((p) => window.opfs.exists(p), `${dir.slice(1)}/opened`)))
    await new Promise((resolve) => setTimeout(resolve, 20));
  return { page, other };
}

const kept = (page) =>
  page.evaluate(async () => {
    const top = await navigator.storage.getDirectory();
    const dir = await top.getDirectoryHandle('.slicc-unlinked').catch(() => undefined);
    if (!dir) return [];
    const out = [];
    for await (const [, handle] of dir.entries()) out.push(await (await handle.getFile()).text());
    return out;
  });

test("another tab's rm of a file this tab holds open keeps it for the descriptor, which writes it back without making the name again (#1409)", {
  timeout: 900_000,
}, async (t) => {
  const dir = '/root/pk1';
  const { page, other } = await setup(t, dir);
  assert.deepEqual(await sh(other, `rm ${dir}/f && echo removed`), ok('removed\n'));
  assert.deepEqual(await kept(page), ['old\n']);
  await sh(page, `: > ${dir}/go`);
  const r = await page.evaluate(() => window.holder);
  console.log(`live holder: ${r.stdout.trim()} ${r.stderr.trim()}`);
  assert.equal(r.stdout, 'old kept\n');
  assert.equal((await sh(other, `[ -e ${dir}/f ] && echo back || echo gone`)).stdout, 'gone\n');
});

test('an rm by another tab of a file a frozen tab holds open succeeds, keeps the file, and the thawed descriptor reads it (#1409)', {
  timeout: 900_000,
}, async (t) => {
  const dir = '/root/pk2';
  const { page, other } = await setup(t, dir);
  await steer(page, { set: { freeze: true } });
  const t0 = Date.now();
  assert.deepEqual(await sh(other, `rm ${dir}/f && echo removed`), ok('removed\n'));
  const took = Date.now() - t0;
  assert.deepEqual(await kept(other), ['old\n']);
  await steer(page, { thaw: true });
  await sh(page, `: > ${dir}/go`);
  const r = await page.evaluate(() => window.holder);
  console.log(`frozen holder: rm took ${took} ms; ${r.stdout.trim()} ${r.stderr.trim()}`);
  assert.ok(took < 5000, `the rm took ${took} ms`);
  assert.equal(r.stdout, 'old kept\n');
  assert.equal((await sh(other, `[ -e ${dir}/f ] && echo back || echo gone`)).stdout, 'gone\n');
});

test('a rename over a file a frozen tab holds open is EBUSY and changes nothing; unfrozen, it goes ahead and the descriptor keeps its file (#1409)', {
  timeout: 900_000,
}, async (t) => {
  const dir = '/root/pk3';
  const { page, other } = await setup(t, dir);
  await steer(page, { set: { freeze: true } });
  const busy = await sh(other, `cd ${dir} && echo NEW > h && mv h f; echo "rc=$?"; cat f h`);
  console.log(`frozen rename-over: ${JSON.stringify(busy)}`);
  assert.match(busy.stdout, /rc=1\nold\nNEW\n$/);
  await steer(page, { thaw: true });
  assert.deepEqual(await sh(other, `cd ${dir} && mv h f && cat f`), ok('NEW\n'));
  await sh(page, `: > ${dir}/go`);
  const r = await page.evaluate(() => window.holder);
  console.log(`thawed holder: ${r.stdout.trim()} ${r.stderr.trim()}`);
  assert.equal(r.stdout, 'old kept\n');
  assert.equal((await sh(other, `cat ${dir}/f`)).stdout, 'NEW\n');
});

test('a holder whose tab runs 4(a) only (holds without an instance) is never asked: rm and a rename over its file behave as before (#1607 review)', {
  timeout: 900_000,
}, async (t) => {
  const dir = '/root/pk4';
  const { page } = await booted(chrome, t, { worker: `${PEER_WORKER}?holds-only=1` });
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page);
  assert.deepEqual(
    await sh(
      page,
      `rm -rf ${dir} && mkdir -p ${dir} && echo old > ${dir}/f && echo old > ${dir}/f2 && echo made`
    ),
    ok('made\n')
  );
  await page.evaluate(
    (s) => {
      window.holder = window.kernel.run(['python3', '-c', s], { cwd: '/' });
    },
    HOLDER(dir).replace(
      `os.open('${dir}/f', os.O_RDWR)`,
      `os.open('${dir}/f', os.O_RDWR); fd2 = os.open('${dir}/f2', os.O_RDWR)`
    )
  );
  while (!(await page.evaluate((p) => window.opfs.exists(p), `${dir.slice(1)}/opened`)))
    await new Promise((resolve) => setTimeout(resolve, 20));
  for (;;) {
    const listed = (await sh(other, 'cat /proc/sys/kernel/slicc_peer_held')).stdout;
    if (listed.includes(`${dir}/f2`)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  let t0 = Date.now();
  assert.deepEqual(await sh(other, `rm ${dir}/f && echo removed`), ok('removed\n'));
  const rm = Date.now() - t0;
  t0 = Date.now();
  assert.deepEqual(await sh(other, `cd ${dir} && echo NEW > h && mv h f2 && cat f2`), ok('NEW\n'));
  const mv = Date.now() - t0;
  console.log(`4(a) holder: rm ${rm} ms, mv over ${mv} ms`);
  assert.ok(rm < 800 && mv < 800, `rm ${rm} ms, mv ${mv} ms`);
  assert.deepEqual(await kept(other), []);
  await sh(page, `: > ${dir}/go`);
  await page.evaluate(() => window.holder);
});

test("a holder's gate on a path opens when the tab that asked for it goes away before saying kept (#1607 review)", {
  timeout: 900_000,
}, async (t) => {
  const dir = '/root/pk5';
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const other = await peerTab(page, { worker: '/rename/pause-worker.js?id=h' });
  assert.deepEqual(
    await sh(page, `rm -rf ${dir} && mkdir -p ${dir} && echo old > ${dir}/f && echo made`),
    ok('made\n')
  );
  await page.evaluate((s) => {
    window.holder = window.kernel.run(['python3', '-c', s], { cwd: '/' });
  }, HOLDER(dir));
  while (!(await page.evaluate((p) => window.opfs.exists(p), `${dir.slice(1)}/opened`)))
    await new Promise((resolve) => setTimeout(resolve, 20));
  for (;;) {
    const listed = (await sh(other, 'cat /proc/sys/kernel/slicc_peer_held')).stdout;
    if (listed.includes(`${dir}/f`)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await steer(other, { set: { freeze: true } });
  await other.evaluate((d) => {
    window.removing = window.kernel.run(['bash', '-c', `rm ${d}/f`], { cwd: '/' });
  }, dir);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await other.close();
  const t0 = Date.now();
  await sh(page, `: > ${dir}/go`);
  const r = await page.evaluate(() => window.holder);
  const took = Date.now() - t0;
  console.log(`gate after the asker left: ${took} ms; ${r.stdout.trim()} ${r.stderr.trim()}`);
  assert.ok(took < 8000, `the holder waited ${took} ms`);
  assert.equal(r.stdout, 'old kept\n');
});

test('a rename onto, or a removal of the directory of, a file another tab holds open that fails leaves the file where it was (#1607 review)', {
  timeout: 900_000,
}, async (t) => {
  const dir = '/root/pk6';
  const { page, other } = await setup(t, dir);
  for (;;) {
    const listed = (await sh(other, 'cat /proc/sys/kernel/slicc_peer_held')).stdout;
    if (listed.includes(`${dir}/f`)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const tries = await sh(
    other,
    [
      `mv ${dir}/missing ${dir}/f; echo "mv=$?"`,
      `rmdir ${dir}; echo "rmdir=$?"`,
      `mkdir -p /root/pk6e && python3 -c "import os; os.rename('/root/pk6e', '${dir}')" 2> /dev/null; echo "dir=$?"`,
      `cat ${dir}/f`,
    ].join('; ')
  );
  console.log(`failed ops: ${JSON.stringify(tries)}`);
  assert.match(tries.stdout, /mv=1\nrmdir=1\ndir=1\nold\n$/);
  assert.deepEqual(await kept(other), []);
  await sh(page, `: > ${dir}/go`);
  const r = await page.evaluate(() => window.holder);
  assert.equal(r.stdout, 'old kept\n');
  assert.equal((await sh(other, `cat ${dir}/f`)).stdout, 'kept');
});
