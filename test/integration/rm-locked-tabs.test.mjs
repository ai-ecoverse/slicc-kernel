import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const HOLDER = `
  onmessage = async ({ data }) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('tmp')).getDirectoryHandle('rl');
    const end = performance.now() + data.ms;
    let holds = 0;
    while (performance.now() < end) {
      let handle;
      try {
        const file = await dir.getFileHandle('f');
        handle = await file.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
        holds++;
        await new Promise((resolve) => setTimeout(resolve, 3));
      } catch {
      } finally {
        handle?.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    postMessage(holds);
  };`;

test("a removal waits out another context's short-lived sync access handle on the file instead of failing (#1458)", {
  timeout: 600_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  assert.deepEqual(
    await sh(page, 'rm -rf /tmp/rl && mkdir -p /tmp/rl && echo x > /tmp/rl/f && echo made'),
    ok('made\n')
  );
  const holding = page.evaluate(
    (src) =>
      new Promise((resolve) => {
        const worker = new Worker(URL.createObjectURL(new Blob([src])));
        worker.onmessage = ({ data }) => {
          worker.terminate();
          resolve(data);
        };
        worker.postMessage({ ms: 8000 });
      }),
    HOLDER
  );
  const removed = await sh(
    page,
    [
      'cd /tmp/rl',
      'n=0; busy=0; end=$((SECONDS + 6))',
      'while [ $SECONDS -lt $end ]; do',
      '  if ! out=$(rm f 2>&1); then case $out in *busy*) busy=$((busy+1));; esac; fi',
      '  echo x > f',
      '  n=$((n+1))',
      'done',
      'echo "removals $n busy $busy"',
    ].join('\n')
  );
  const holds = await holding;
  console.log(`${removed.stdout.trim()}, holds ${holds}`);
  assert.ok(holds > 0, 'the holder never got a handle');
  assert.match(removed.stdout, /^removals [1-9]\d* busy 0\n$/, removed.stdout + removed.stderr);
});
