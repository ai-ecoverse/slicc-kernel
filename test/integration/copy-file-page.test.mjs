import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const SIZE = 8 * 1024 * 1024;
const ROUNDS = 12;
const FILES = 60;

async function withCopytest(t) {
  const booting = await booted(chrome, t, { users: 'enforce' });
  await booting.page.evaluate(
    (n) => window.copyTree('fixtures/copytest/', 'node_modules/copytest/', n),
    ['package.json', 'bin/copytest.wasm']
  );
  return booting;
}

test('on the OPFS root a copy is whole or absent to another process (#1017)', async (t) => {
  const { bash } = await withCopytest(t);
  assert.deepEqual(
    await bash(
      `rm -rf /home/cp && mkdir -p /home/cp && head -c ${SIZE} /dev/urandom > /home/cp/src`,
      {
        cwd: '/',
      }
    ),
    ok()
  );
  const r = await bash(
    [
      'cd /home/cp',
      `(for r in $(seq ${ROUNDS}); do copytest copy src d 644 1 > /dev/null; rm d; done; : > stop) &`,
      'n=0',
      'while [ ! -e stop ]; do',
      '  if s=$(stat -c %s d 2> /dev/null); then',
      `    [ "$s" = ${SIZE} ] || echo "partial $s"`,
      '    n=$((n+1))',
      '  fi',
      'done',
      'wait',
      'echo "seen $n"',
    ].join('\n'),
    { cwd: '/' }
  );
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines.at(-1), /^seen [1-9]\d*$/, r.stdout);
  assert.deepEqual(lines.slice(0, -1), []);
});

test('on the OPFS root a copied file costs one kernel call and fewer OPFS lookups than a read and a write (#1017)', async (t) => {
  const { bash } = await withCopytest(t);
  const r = await bash(
    [
      'rm -rf /home/cn && mkdir -p /home/cn/s /home/cn/d /home/cn/e && cd /home/cn/s',
      `x=$(printf '%04000d' 0); for i in $(seq 0 ${FILES - 1}); do echo "$i$x" > f$i; done`,
      `copytest many /home/cn/s /home/cn/d ${FILES}`,
      'k() { for n in slicc_fs_calls slicc_opfs_calls slicc_opfs_ops; do cat /proc/sys/kernel/$n 2> /dev/null || echo 0; done; }',
      'a=$(k)',
      `for i in $(seq 0 ${FILES - 1}); do v=$(< f$i); echo "$v" > /home/cn/e/f$i; done`,
      'b=$(k)',
      'echo $a $b',
    ].join('\n'),
    { cwd: '/' }
  );
  assert.equal(r.status, 0, r.stderr);
  const [copied, before] = r.stdout.trim().split('\n');
  const [calls, lookups, requests] = copied.split(' ').map((v) => Number(v) / FILES);
  const v = before.split(' ').map(Number);
  const plain = [v[3] - v[0], v[4] - v[1], v[5] - v[2]].map((x) => x / FILES);
  console.log(
    `per file: copy_file ${calls.toFixed(2)} calls / ${lookups.toFixed(2)} lookups / ${requests.toFixed(2)} requests; bash read and write ${plain.map((x) => x.toFixed(2)).join(' / ')}`
  );
  assert.ok(calls <= 1.5, `${calls} kernel calls per copy`);
  assert.ok(
    lookups < plain[1],
    `${lookups} OPFS lookups per copy, ${plain[1]} for a bash read and write`
  );
});
