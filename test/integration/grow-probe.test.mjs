import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const RUNS = Number(process.env.GROW_RUNS || 200);

test(`a WASIX program whose threads grow memory while other threads write into the new pages never traps, ${RUNS} runs in the page (homescoop#1127)`, async (t) => {
  const { page } = await booted(chrome, t);
  await page.evaluate(async () => {
    const bytes = new Uint8Array(
      await (await fetch('/fixtures/growprobe/bin/grow.wasm')).arrayBuffer()
    );
    await window.opfs.write('node_modules/growprobe/bin/grow.wasm', bytes);
    await window.opfs.write(
      'node_modules/growprobe/package.json',
      JSON.stringify({
        name: 'growprobe',
        slicc: { abi: 'wasi', commands: { growprobe: { wasm: 'bin/grow.wasm' } } },
      })
    );
  });
  const bad = [];
  for (let i = 1; i <= RUNS; i++) {
    const r = await page.evaluate((o) => window.kernel.run(['growprobe'], o), {
      cwd: '/tmp',
      env: { SLICC_WASM_BACKTRACE: '1' },
    });
    const all = `${r.stdout}${r.stderr}`;
    if (r.status !== 0 || /trap|out of bounds/.test(all))
      bad.push(`run ${i}: ${r.status} ${all.slice(0, 600)}`);
  }
  console.log(
    `grow-probe: ${RUNS - bad.length}/${RUNS} clean on ${await page.evaluate(() => navigator.userAgent)}`
  );
  for (const line of bad) console.log(line);
  assert.deepEqual(bad, []);
});
