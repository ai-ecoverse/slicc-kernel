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
