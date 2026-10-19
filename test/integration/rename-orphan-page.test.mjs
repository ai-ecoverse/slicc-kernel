import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const FILES = 600;
const KILL_AT = 20;
const FINISH_MS = 60_000;

test('a peer killed mid directory rename: the survivor finishes it, modes and inodes kept (#1141)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash(
      `rm -rf /home/r && mkdir -p /home/r/s && cd /home/r/s && for i in $(seq ${FILES}); do echo v$i > f$i; done && chmod 640 f1 && chmod 750 /home/r/s`,
      { cwd: '/' }
    ),
    ok()
  );
  const shape = (dir) => bash(`stat -c '%a %i' ${dir} ${dir}/f1 ${dir}/f${FILES}`, { cwd: '/' });
  const before = await shape('/home/r/s');
  assert.equal(before.status, 0, before.stderr);
  const out = await page.evaluate(
    async (files, killAt, finishMs) => {
      await window.secondKernel({});
      const count = async (path) => (await window.opfs.list(path).catch(() => [])).length;
      void window.second.run(['mv', '/home/r/s', '/home/r/d'], { cwd: '/' }).catch(() => null);
      while ((await count('home/r/d')) < killAt) await new Promise((r) => setTimeout(r, 1));
      window.second.terminate();
      const split = [await count('home/r/s'), await count('home/r/d')];
      const end = Date.now() + finishMs;
      let last;
      while (Date.now() < end) {
        last = await window.kernel.run(
          ['bash', '-c', 'ls /home/r/d | wc -l; test -e /home/r/s && echo source-left; true'],
          { cwd: '/' }
        );
        if (last.stdout.trim() === String(files)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const bytes = await window.kernel.run(
        ['bash', '-c', `cd /home/r/d && cat f1 f${Math.floor(files / 2)} f${files}`],
        { cwd: '/' }
      );
      return { split, last: last?.stdout, bytes: bytes.stdout };
    },
    FILES,
    KILL_AT,
    FINISH_MS
  );
  assert.ok(out.split[0] > 0 && out.split[1] < FILES, JSON.stringify(out));
  assert.equal(out.last.trim(), String(FILES), JSON.stringify(out));
  assert.equal(out.bytes, `v1\nv${FILES / 2}\nv${FILES}\n`);
  assert.deepEqual(await shape('/home/r/d'), before);
});
