import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { launch as start } from '@ai-ecoverse/slicc-shared-web/harness';
import { booted, installPackage, ok } from './kernel.mjs';
import { joined, sh, tree, whole, wholeAs } from './rename-tabs.mjs';

const FILES = 120;
const ROUNDS = 6;

let prev;
let chrome;

async function released() {
  const meta = await (
    await fetch('https://registry.npmjs.org/@ai-ecoverse%2fslicc-kernel/latest')
  ).json();
  const tarball = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const dir = await mkdtemp(join(tmpdir(), 'slicc-prev-kernel-'));
  await writeFile(join(dir, 'kernel.tgz'), tarball);
  execFileSync('tar', ['-xzf', join(dir, 'kernel.tgz'), '-C', dir]);
  return { dir, version: meta.version };
}

before(async () => {
  prev = await released();
  chrome = await start({
    roots: [
      ['/dist/', 'dist/'],
      ['/prev/', join(prev.dir, 'package', 'dist')],
      ['/node_modules/@ai-ecoverse/', 'node_modules/@ai-ecoverse/'],
      ['/fixtures/', 'test/integration/fixtures/'],
      ['/', 'test/integration/page/'],
    ],
    isolated: true,
    timeout: 150000,
    coverage: [],
  });
});

after(async () => {
  await chrome?.close();
  if (prev) await rm(prev.dir, { recursive: true, force: true });
});

const LIST = (dir) =>
  `cd ${dir} && n=0; while [ ! -e stop ]; do ls a/lib b/lib > /dev/null 2>&1; n=$((n+1)); done; echo "listed $n"`;

const BACK_AND_FORTH = (dir) =>
  `cd ${dir} && for r in $(seq ${ROUNDS}); do mv a b && mv b a || echo "mv failed $r"; done; : > stop; echo renamed`;

const WRITER = (dir) =>
  `cd ${dir} && n=0; while [ ! -e stop ]; do echo $n >> a/log 2>/dev/null || echo $n >> b/log 2>/dev/null; n=$((n+1)); done; echo "wrote $n"`;

test('a peer on the last released kernel and this kernel rename directories under each other without a hang, and this kernel keeps every file (#1140)', {
  timeout: 1_500_000,
}, async (t) => {
  const { page } = await booted(chrome, t);
  await installPackage(page, 'wasm-coreutils');
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await other.evaluate(async () => {
    const { createKernel } = await import('/prev/index.js');
    window.kernel = await createKernel({ root: await navigator.storage.getDirectory() });
  });
  await joined(page);
  console.log(`the older peer is ${prev.version}`);
  for (const [renamer, peer, label] of [
    [page, other, 'this kernel renames'],
    [other, page, 'the older kernel renames'],
  ]) {
    const dir = `/root/rm-${renamer === page ? 'new' : 'old'}`;
    assert.deepEqual(await sh(page, tree(dir, FILES)), ok('made\n'));
    await peer.evaluate(
      (list, write) => {
        window.listRun = window.kernel.run(['bash', '-c', list], { cwd: '/' });
        window.writeRun = window.kernel.run(['bash', '-c', write], { cwd: '/' });
      },
      LIST(dir),
      WRITER(dir)
    );
    assert.deepEqual(await sh(renamer, BACK_AND_FORTH(dir)), ok('renamed\n'), label);
    const [listed, wrote] = await peer.evaluate(() =>
      Promise.all([window.listRun, window.writeRun])
    );
    console.log(`${label}: ${listed.stdout.trim()}, ${wrote.stdout.trim()}`);
    assert.match(listed.stdout, /^listed \d+\n$/, label);
    assert.match(wrote.stdout, /^wrote \d+\n$/, label);
    const seen = await sh(page, whole(dir));
    assert.ok(wholeAs(FILES)(seen.stdout), `${label}: ${seen.stdout}`);
  }
});
