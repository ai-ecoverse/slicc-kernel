import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const N = 200;
const DEEP = '/root/m/a/b/c/d/e/f';

const py = (lines) =>
  `python3 -c "$(echo ${Buffer.from(lines.join('\n')).toString('base64')} | base64 -d)"`;

test('on the OPFS root, a stat of a missing name six directories down costs about one OPFS call (at most 1.25), from python and from bash, so saying whether a miss was direct reaches no further into OPFS (#1017)', {
  timeout: 600_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const made = await bash(`mkdir -p ${DEEP} && : > ${DEEP}/here`, { cwd: '/' });
  assert.equal(made.status, 0, made.stderr);
  const loops = {
    python: (n) =>
      py([
        'import os',
        `print(sum(os.path.exists('${DEEP}/m%d' % i) for i in range(${n})) + os.path.exists('${DEEP}/here'))`,
      ]),
    bash: (n) =>
      `i=0; k=1; while [ $i -lt ${n} ]; do [ -e ${DEEP}/m$i ] && k=$((k+1)); i=$((i+1)); done; echo $k`,
  };
  const counts = async (loop, n) => {
    const r = await bash(
      [
        'read -r o0 < /proc/sys/kernel/slicc_opfs_calls',
        loop(n),
        'read -r o1 < /proc/sys/kernel/slicc_opfs_calls',
        'echo $((o1-o0))',
      ].join('\n'),
      { cwd: '/' }
    );
    assert.equal(r.status, 0, r.stderr);
    const [found, opfs] = r.stdout.trim().split('\n');
    assert.equal(found, '1');
    return Number(opfs);
  };
  const seen = [];
  for (const [name, loop] of Object.entries(loops)) {
    await counts(loop, N);
    const none = await counts(loop, 0);
    const start = Date.now();
    const opfs = await counts(loop, N);
    const per = (opfs - none) / N;
    seen.push(`${name} ${per.toFixed(2)} OPFS calls, ${((Date.now() - start) / N).toFixed(2)} ms`);
    assert.ok(per <= 1.25, `${name}: ${per} OPFS calls per miss`);
  }
  console.log(`per miss six directories down: ${seen.join('; ')}`);
});
