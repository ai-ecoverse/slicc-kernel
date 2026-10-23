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

test('with an idle second tab sharing the root, four threads appending records to one fd leave every record exactly once, within the timeout (#1525 timing)', {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t, { users: 'enforce' });
  await page.evaluate(
    (n) => window.copyTree('fixtures/fdrace/', 'node_modules/fdrace/', n),
    ['package.json', 'bin/fdrace.wasm']
  );
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await other.evaluate(() => window.secondKernel({}, 'kernel'));
  for (let i = 0; i < 300; i++) {
    const r = await page.evaluate(() =>
      window.kernel.run(['bash', '-c', 'cat /proc/sys/kernel/slicc_shared_root'], { cwd: '/' })
    );
    if (Number(r.stdout) === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const began = performance.now();
  const res = await page.evaluate(() =>
    window.kernel.run(['fdrace', '/home/fdrace-shared-append', 'append'], { cwd: '/' })
  );
  const took = performance.now() - began;
  console.log(
    `#1525 timing: 4 threads × 1000 O_APPEND records with a second tab took ${Math.round(took)} ms`
  );
  assert.equal(
    `${res.status} ${res.stdout.trim()}`,
    '0 records 4000 torn 0 dup 0 missing 0 size 64000'
  );
});
