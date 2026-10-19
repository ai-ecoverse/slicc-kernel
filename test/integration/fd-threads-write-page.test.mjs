import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const ROUNDS = 5;
const HOGS = 4;

test('on the OPFS root under load, four threads writing records to one fd leave every record exactly once, shared offset and O_APPEND (homescoop#1127)', async (t) => {
  const { page } = await booted(chrome, t, { users: 'enforce' });
  await page.evaluate(
    (n) => window.copyTree('fixtures/fdrace/', 'node_modules/fdrace/', n),
    ['package.json', 'bin/fdrace.wasm']
  );
  const out = await page.evaluate(
    async (rounds, hogs) => {
      const spin = 'const end = Date.now() + 600000; while (Date.now() < end);';
      const url = URL.createObjectURL(new Blob([spin]));
      const workers = Array.from({ length: hogs }, () => new Worker(url));
      const lines = [];
      try {
        for (let r = 0; r < rounds; r++) {
          for (const mode of ['shared', 'append']) {
            const res = await window.kernel.run(['fdrace', `/home/fdrace-${mode}`, mode], {
              cwd: '/',
            });
            lines.push(`${mode} ${res.status} ${res.stdout.trim()} ${res.stderr.trim()}`);
          }
        }
      } finally {
        for (const w of workers) w.terminate();
      }
      return lines;
    },
    ROUNDS,
    HOGS
  );
  const want = (mode) => `${mode} 0 records 4000 torn 0 dup 0 missing 0 size 64000 `;
  assert.deepEqual(
    out.map((line) => `${line} `.replace(/ +$/, ' ')),
    Array.from({ length: ROUNDS }, () => [want('shared'), want('append')]).flat()
  );
});
