import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const LINKS = 60;

test('a tab that boots while another extracts symlinks with tar leaves every symlink in place (bios tar symlink drop)', async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  for (const name of ['wasm-coreutils', 'wasm-tar']) await installPackage(page, name);
  assert.deepEqual(
    await bash(
      `mkdir -p /tmp/pack/src/inner && cd /tmp/pack/src/inner && echo first > ../a.txt && for i in $(seq ${LINKS}); do ln -s ../a.txt l$i; done && cd /tmp/pack && tar -cf src.tar src && echo packed`,
      { cwd: '/' }
    ),
    ok('packed\n')
  );
  const other = await page.tab();
  const size = Number((await bash('wc -c < /tmp/pack/src.tar', { cwd: '/' })).stdout);
  for (let round = 0; round < 2; round++) {
    const extracting = bash(
      `cd /tmp/pack && rm -rf out go && mkdir out && { head -c ${size - 10240} src.tar; while [ ! -e go ]; do sleep 0.05; done; tail -c 10240 src.tar; } | tar -xf - -C out && echo "unpack=$?"`,
      { cwd: '/' }
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const go = bash(': > /tmp/pack/go', { cwd: '/' });
    let done = false;
    void extracting.finally(() => {
      done = true;
    });
    let boots = 0;
    while (!done && boots < 3) {
      await other.goto('/');
      await other.until(() => typeof window.boot === 'function');
      await other.evaluate(() => window.boot({ users: 'enforce' }));
      boots++;
    }
    await go;
    assert.deepEqual(await extracting, ok('unpack=0\n'));
    const count = `cd /tmp/pack/out/src/inner && echo "names=$(ls | wc -l) links=$(ls -l | { n=0; while read -r m _; do case $m in l*) n=$((n + 1)) ;; esac; done; echo $n; }) last=$(readlink l${LINKS})"`;
    assert.deepEqual(
      await bash(`sleep 1.2; ${count}`, { cwd: '/' }),
      ok(`names=${LINKS} links=${LINKS} last=../a.txt\n`),
      `round ${round}`
    );
    assert.deepEqual(
      await other.evaluate((s) => window.kernel.run(['bash', '-c', s], { cwd: '/' }), count),
      ok(`names=${LINKS} links=${LINKS} last=../a.txt\n`),
      `round ${round}, the other tab`
    );
  }
});
