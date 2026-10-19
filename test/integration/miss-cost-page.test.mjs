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

test('on the OPFS root a missing name six directories down stays near one OPFS call per stat (under 1.5), from python and bash (#1017)', {
  timeout: 600_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  const made = await bash(`mkdir -p ${DEEP} && : > ${DEEP}/here`, { cwd: '/' });
  assert.equal(made.status, 0, made.stderr);
  const calls = "int(open('/proc/sys/kernel/slicc_opfs_calls').read())";
  const loops = {
    python: py([
      'import os',
      `n = ${N}`,
      `[os.path.exists('${DEEP}/w%d' % i) for i in range(n)]`,
      'least = None',
      'import time',
      'for r in range(3):',
      '  b, quiet = None, 0',
      '  while quiet < 10:',
      `    c = ${calls}`,
      '    quiet = quiet + 1 if c == b else 0',
      '    b = c',
      '    time.sleep(0.05)',
      `  a = ${calls}`,
      `  found = sum(os.path.exists('${DEEP}/m%d_%d' % (r, i)) for i in range(n))`,
      `  b = ${calls}`,
      '  least = b - a if least is None else min(least, b - a)',
      `print(found + os.path.exists('${DEEP}/here'))`,
      'print(least)',
    ]),
    bash: [
      `i=0; while [ $i -lt ${N} ]; do [ -e ${DEEP}/w$i ]; i=$((i+1)); done`,
      'least=',
      'for r in 0 1 2; do',
      '  read -r a < /proc/sys/kernel/slicc_opfs_calls',
      `  i=0; k=1; while [ $i -lt ${N} ]; do [ -e ${DEEP}/m\${r}_$i ] && k=$((k+1)); i=$((i+1)); done`,
      '  read -r b < /proc/sys/kernel/slicc_opfs_calls',
      '  d=$((b-a)); if [ -z "$least" ] || [ $d -lt $least ]; then least=$d; fi',
      'done',
      'echo $k; echo $least',
    ].join('\n'),
  };
  const seen = [];
  for (const [name, script] of Object.entries(loops)) {
    const r = await bash(script, { cwd: '/' });
    assert.equal(r.status, 0, r.stderr);
    const [found, opfs] = r.stdout.trim().split('\n');
    assert.equal(found, '1');
    const per = Number(opfs) / N;
    seen.push(`${name} ${per.toFixed(2)} OPFS calls`);
    assert.ok(per <= 1.5, `${name}: ${per} OPFS calls per miss`);
  }
  console.log(`per miss six directories down: ${seen.join('; ')}`);
});
