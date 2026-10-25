import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const steer = (tab, id, msg) =>
  tab.evaluate(
    ({ id, msg }) =>
      new Promise((resolve) => {
        const channel = new BroadcastChannel('pause-control');
        const seq = Math.random();
        channel.onmessage = ({ data }) => {
          if (data?.done !== seq) return;
          channel.close();
          resolve();
        };
        channel.postMessage({ id, seq, ...msg });
      }),
    { id, msg }
  );

const listen = (tab) =>
  tab.evaluate(() => {
    window.pauseLog = [];
    const channel = new BroadcastChannel('pause-control');
    channel.onmessage = ({ data }) => window.pauseLog.push(data);
  });

const heard = async (tab, match) => {
  for (;;) {
    const log = await tab.evaluate(() => window.pauseLog);
    if (log.some(match)) return;
    await sleep(20);
  }
};

const kept = (page) =>
  page.evaluate(async () => {
    const top = await navigator.storage.getDirectory();
    const dir = await top.getDirectoryHandle('.slicc-unlinked').catch(() => undefined);
    if (!dir) return [];
    const out = [];
    for await (const [, handle] of dir.entries()) out.push(await (await handle.getFile()).text());
    return out.sort();
  });

const HOLDER = (dir, names, kernel) =>
  [
    'import os, time',
    `fds = [os.open('${dir}/' + n, os.O_RDWR) for n in ${JSON.stringify(names)}]`,
    ...(kernel ? ["os.system('true')"] : []),
    `open('${dir}/opened', 'w').close()`,
    `while not os.path.exists('${dir}/go'): time.sleep(0.02)`,
    'out = []',
    'for fd in fds:',
    '    try:',
    '        out.append(os.pread(fd, 16, 0).decode().strip())',
    '    except OSError as e:',
    "        out.append(f'errno {e.errno}')",
    "print(' '.join(out))",
  ].join('\n');

async function holding(t, dir, names, kernel) {
  const { page } = await booted(chrome, t, { worker: '/rename/pause-worker.js?id=h' });
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const made = names.map((name) => `echo ${name} > ${name}`).join(' && ');
  assert.deepEqual(
    await sh(page, `rm -rf ${dir} && mkdir -p ${dir} && cd ${dir} && ${made} && echo made`),
    ok('made\n')
  );
  await page.evaluate(
    (s) => {
      window.holder = window.kernel.run(['python3', '-c', s], { cwd: '/' });
    },
    HOLDER(dir, names, kernel)
  );
  while (!(await page.evaluate((p) => window.opfs.exists(p), `${dir.slice(1)}/opened`)))
    await sleep(20);
  await listen(page);
  await steer(page, 'h', { set: { pause: `${dir}/${names[0]}` } });
  return page;
}

const text = (bytes) => (typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes));

for (const [name, kernel] of [
  ['a descriptor', false],
  ['a kernel descriptor', true],
]) {
  test(`files held through ${name} before another tab joins are kept for it when that tab removes them at once, while their ids are still being bound (#1623)`, {
    timeout: 900_000,
  }, async (t) => {
    const dir = `/root/pkj${kernel ? 'k' : 'd'}`;
    const names = ['f1', 'f2', 'f3', 'f4'];
    const page = await holding(t, dir, names, kernel);
    const other = await peerTab(page);
    await heard(page, (m) => m.id === 'h' && m.held === `${dir}/f1`);
    assert.deepEqual(
      await sh(other, `cd ${dir} && rm ${names.join(' ')} && echo removed`),
      ok('removed\n')
    );
    const set = await kept(other);
    await steer(page, 'h', { release: true });
    await sh(page, `: > ${dir}/go`);
    const r = await page.evaluate(() => window.holder);
    console.log(
      `removed at the join (${name}): kept ${JSON.stringify(set)}; ${text(r.stdout).trim()}`
    );
    assert.deepEqual(set, ['f1\n', 'f2\n', 'f3\n', 'f4\n']);
    assert.equal(text(r.stdout), 'f1 f2 f3 f4\n');
  });

  test(`a file held through ${name} whose id is bound after its hold was announced without one is kept for it when another tab renames over it (#1623)`, {
    timeout: 900_000,
  }, async (t) => {
    const dir = `/root/pkb${kernel ? 'k' : 'd'}`;
    const page = await holding(t, dir, ['f'], kernel);
    const other = await peerTab(page, { worker: '/rename/pause-worker.js?id=o' });
    await heard(page, (m) => m.id === 'h' && m.held === `${dir}/f`);
    let listed = '';
    for (let i = 0; i < 200 && !listed.includes(`${dir}/f`); i++) {
      listed = (await sh(other, 'cat /proc/sys/kernel/slicc_peer_held')).stdout;
      if (!listed.includes(`${dir}/f`)) await sleep(25);
    }
    assert.ok(listed.includes(`${dir}/f`), `the joined tab sees ${JSON.stringify(listed)}`);
    await steer(page, 'h', { set: { freeze: true } });
    await steer(page, 'o', { set: { watch: `${dir}/f` } });
    await other.evaluate((d) => {
      window.mover = window.kernel.run(
        ['bash', '-c', `cd ${d} && echo NEW > h && mv h f; echo "rc=$?"; cat f`],
        { cwd: '/' }
      );
    }, dir);
    await heard(page, (m) => m.id === 'h' && m.keepings >= 1);
    await steer(page, 'h', { release: true });
    await heard(page, (m) => m.id === 'o' && m.bound === `${dir}/f`);
    await steer(page, 'h', { thaw: true });
    const mv = await other.evaluate(() => window.mover);
    await sh(page, `: > ${dir}/go`);
    const r = await page.evaluate(() => window.holder);
    console.log(
      `bound after the announce (${name}): ${JSON.stringify(text(mv.stdout))} ${text(r.stdout).trim()}`
    );
    assert.equal(text(mv.stdout), 'rc=0\nNEW\n', text(mv.stderr));
    assert.equal(text(r.stdout), 'f\n');
  });
}
