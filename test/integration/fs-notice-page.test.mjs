import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const WAIT_MS = 10_000;

const WATCHER = [
  'cd /home/nt',
  'start=$SECONDS',
  'read -r v < f; [ -e d/new ]; [ -e d/old ]',
  ': > /home/nt/polled',
  'while :; do',
  '  read -r v < f',
  '  if [ "$v" = 1234 ] && [ -e d/new ] && [ ! -e d/old ]; then echo seen; break; fi',
  `  if [ $((SECONDS - start)) -ge ${WAIT_MS / 1000} ]; then echo "stale $v"; break; fi`,
  'done',
].join('\n');

for (const notice of ['paths', 'trees']) {
  test(`a running program sees a write outside the kernel once its ${notice} notice is posted (#1017)`, async (t) => {
    const { page, bash } = await booted(chrome, t);
    assert.deepEqual(
      await bash(
        'rm -rf /home/nt && mkdir -p /home/nt/d && echo 1 > /home/nt/f && touch /home/nt/d/old',
        {
          cwd: '/',
        }
      ),
      ok()
    );
    const out = await page.evaluate(
      async (script, kind) => {
        const { postFsNotice } = await import('/dist/meta.js');
        const watching = window.kernel.run(['bash', '-c', script], { cwd: '/' });
        while (!(await window.opfs.exists('home/nt/polled')))
          await new Promise((r) => setTimeout(r, 20));
        await window.opfs.write('home/nt/f', '1234');
        await window.remove('home/nt/d/old');
        await window.opfs.write('home/nt/d/new', 'n');
        if (kind === 'paths')
          postFsNotice({ paths: ['/home/nt/f', '/home/nt/d', '/home/nt/d/old', '/home/nt/d/new'] });
        else postFsNotice({ trees: ['/home/nt'] });
        return (await watching).stdout;
      },
      WATCHER,
      notice
    );
    assert.equal(out, 'seen\n');
  });
}

for (const notice of [true, false]) {
  test(`an outside append that OPFS leaves at its old mtime ${notice ? 'shows as newer once it is noticed' : 'keeps the old mtime without a notice'} (#1275)`, async (t) => {
    const { page, bash } = await booted(chrome, t);
    assert.deepEqual(
      await bash('rm -rf /home/am && mkdir -p /home/am && echo one > /home/am/log', { cwd: '/' }),
      ok()
    );
    await new Promise((r) => setTimeout(r, 1100));
    assert.deepEqual(await bash(': > /home/am/ref', { cwd: '/' }), ok());
    const before = await page.evaluate(async () => {
      const dir = await (
        await (await navigator.storage.getDirectory()).getDirectoryHandle('home')
      ).getDirectoryHandle('am');
      const file = await dir.getFileHandle('log');
      const was = (await file.getFile()).lastModified;
      const w = await file.createWritable({ keepExistingData: true });
      await w.seek((await file.getFile()).size);
      await w.write('two\n');
      await w.close();
      return [was, (await file.getFile()).lastModified];
    });
    if (notice) {
      await page.evaluate(async () => {
        const { postFsNotice } = await import('/dist/meta.js');
        postFsNotice({ paths: ['/home/am/log'] });
      });
    }
    const script =
      '[ /home/am/log -nt /home/am/ref ] && echo newer || echo older; cat /home/am/log';
    let r;
    for (let i = 0; i < 50; i++) {
      r = await bash(script, { cwd: '/' });
      if (!notice || r.stdout.startsWith('newer')) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const kept = before[0] === before[1];
    assert.deepEqual(
      r,
      ok(`${notice || !kept ? 'newer' : 'older'}\none\ntwo\n`),
      JSON.stringify(before)
    );
  });
}

test("a peer kernel's own change notice leaves the file's mtime as that kernel set it (#1275)", async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash('rm -rf /home/pk && mkdir -p /home/pk && echo x > /home/pk/f', { cwd: '/' }),
    ok()
  );
  const set = await page.evaluate(async () => {
    await window.secondKernel({});
    return window.second.run(
      ['bash', '-c', 'echo y >> /home/pk/f && touch -d @1500000000 /home/pk/f'],
      { cwd: '/' }
    );
  });
  assert.equal(set.status, 0, set.stderr);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(
    await bash('stat -c %Y /home/pk/f; cat /home/pk/f', { cwd: '/' }),
    ok('1500000000\nx\ny\n')
  );
});
