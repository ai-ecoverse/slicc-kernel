import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const SIZE = 64 * 1024 * 1024;

for (let pair = 0; pair < 6; pair++) {
  for (const which of pair % 2 === 0 ? ['head', 'main'] : ['main', 'head']) {
    test(`ab ${pair} ${which}: readInto throughput`, { timeout: 600_000 }, async (t) => {
      const { page } = await booted(
        chrome,
        t,
        which === 'main' ? { worker: '/ab-main/dist/kernel-worker.js' } : {}
      );
      await page.evaluate(async (size) => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('tmp', { create: true });
        const file = await dir.getFileHandle('big', { create: true });
        const writable = await file.createWritable();
        const block = new Uint8Array(1 << 20);
        for (let at = 0; at < size; at += block.length) {
          for (let i = 0; i < block.length; i += 4096) block[i] = (at / 4096 + i / 4096) & 0xff;
          await writable.write(block);
        }
        await writable.close();
      }, SIZE);
      const js = await page.evaluate(() =>
        window.kernel.run(['jstest', 'preadbench', '/tmp/big'], { cwd: '/' })
      );
      assert.equal(js.status, 0, js.stderr);
      const rates = [...js.stdout.matchAll(/^readInto (\d+) (\d+) MB\/s (\w+)/gm)].map(
        (m) => `${m[1]}=${m[2]}${m[3] === 'same' ? '' : '!'}`
      );
      console.log(`AB ${which} pair ${pair}: ${rates.join(' ')}`);
    });
  }
}

test('DO NOT MERGE: this diagnostic PR must never go green', () => {
  assert.fail('DO NOT MERGE');
});
