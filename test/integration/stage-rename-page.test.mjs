import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const FILES = 260;
const ROUNDS = 12;
const HOGS = 4;

const WRITER = [
  'import os, shutil',
  'D = "/root/st"',
  `for r in range(1, ${ROUNDS} + 1):`,
  '    s = f"{D}/.stage{r}"',
  '    os.makedirs(f"{s}/lib")',
  `    for i in range(${FILES}):`,
  '        with open(f"{s}/lib/f{i}.js", "w") as f: f.write(f"v{r} {i}\\n" * 4)',
  '    with open(f"{s}/package.json", "w") as f: f.write("{}\\n")',
  '    if os.path.exists(f"{D}/big"): os.rename(f"{D}/big", f"{D}/.old{r}")',
  '    os.rename(s, f"{D}/big")',
  '    if os.path.exists(f"{D}/.old{r}"): shutil.rmtree(f"{D}/.old{r}")',
  'open(f"{D}/stop", "w").close()',
].join('\n');

const POLLER = [
  'cd /root/st',
  'shopt -s nullglob',
  'n=0',
  'while [ ! -e stop ]; do',
  '  if [ -d big ]; then',
  '    files=(big/lib/*); c=${#files[@]}',
  '    if [ -e big/package.json ]; then p=1; else p=0; fi',
  `    if [ $c -ne 0 ] && { [ $c -ne ${FILES} ] || [ $p -eq 0 ]; }; then echo "partial $c package.json=$p"; fi`,
  '    n=$((n+1))',
  '  fi',
  'done',
  'echo "samples $n"',
].join('\n');

test('on the OPFS root a directory staged and renamed into place is never seen half there (#1122)', {
  timeout: 1_500_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await bash('mkdir -p /root/st', { cwd: '/' });
  await page.evaluate((text) => window.opfs.write('root/stw.py', text), WRITER);
  await page.evaluate((n) => {
    const spin = 'const end = Date.now() + 900000; while (Date.now() < end);';
    const url = URL.createObjectURL(new Blob([spin]));
    window.hogs = Array.from({ length: n }, () => new Worker(url));
  }, HOGS);
  const out = await page.run(
    {
      marker: () => window.__stage,
      quietMs: 60_000,
      maxMs: 1_200_000,
      label: 'the stage renames',
    },
    async (s) => {
      const poll = setInterval(async () => {
        const top = await window.opfs.list('root/st').catch(() => []);
        const files = await Promise.all(
          top.map((name) => window.opfs.list(`root/st/${name}/lib`).catch(() => []))
        );
        window.__stage = `${top.join(',')} ${files.map((f) => f.length).join(',')}`;
      }, 1000);
      const r = await window.kernel.run(['bash', '-c', s], { cwd: '/' });
      clearInterval(poll);
      return r.stdout + r.stderr;
    },
    `(python3 /root/stw.py; echo "writer $?" > /tmp/stage-writer) &\n${POLLER}\nwait\ncat /tmp/stage-writer`
  );
  await page.evaluate(() => {
    for (const hog of window.hogs) hog.terminate();
  });
  const lines = out.trim().split('\n');
  assert.equal(lines.at(-1), 'writer 0', out.slice(-2000));
  assert.match(lines.at(-2), /^samples [1-9]\d*$/, out.slice(-2000));
  assert.deepEqual(lines.slice(0, -2), [], `samples that were half there:\n${out.slice(0, 2000)}`);
});
