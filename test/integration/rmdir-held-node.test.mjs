import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

const ROUNDS = 600;
const READERS = 8;

const REPLACER = `export default async function main(ctx) {
  for (let i = 1; i <= ${ROUNDS}; i++) {
    await ctx.fs.mkdir('/root/rd/n');
    await ctx.fs.writeFile('/root/rd/n/a', 'v' + i + '\\n');
    await ctx.fs.writeFile('/root/rd/n/b', 'v' + i + '\\n');
    await ctx.fs.rm('/root/rd/d');
    await ctx.fs.rename('/root/rd/n', '/root/rd/d');
    await ctx.fs.writeFile('/root/rd/round', String(i));
  }
  await ctx.fs.writeFile('/root/rd/stop', '');
  return 0;
}`;

test('in Node, files opened inside a directory that another process keeps removing and replacing read as a full version every time, never empty (#1013)', {
  timeout: 900_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile(
    '/node_modules/rdrm/package.json',
    JSON.stringify({
      name: 'rdrm',
      slicc: { commands: { rdrm: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/rdrm/main.mjs', REPLACER);
  const script = [
    'mkdir -p /root/rd/d && echo v0 > /root/rd/d/a && echo v0 > /root/rd/d/b && : > /root/rd/err && echo 0 > /root/rd/round',
    'cd /root/rd',
    '(while [ ! -e stop ]; do cat d/a > /dev/null 2>&1; done) &',
    `for r in $(seq ${READERS}); do (while [ ! -e stop ]; do { sleep 0.005; read -r v <&3; rc=$?; case "$v" in v[0-9]*) ;; *) echo "bad [$v] rc=$rc len=\${#v} rest=$(wc -c <&3 2>&1) round=$(cat round 2> /dev/null) fd=$(stat -L -c '%i %s' /dev/fd/3 2>&1) name=$(stat -c '%i %s' d/b 2>&1)" >> err;; esac; } 2> /dev/null 3< d/b; done) & done`,
    'rdrm',
    'echo "replaced $?"',
    'wait',
    'cat err',
  ].join('\n');
  const r = await kernel.run(['bash', '-c', script], { cwd: '/' });
  assert.equal(String(r.stdout), 'replaced 0\n', String(r.stderr));
});

test('in Node, a file whose directory another process removes while bash opens it is not found, rather than opened and read back empty (#1198)', {
  timeout: 300_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile(
    '/node_modules/rdrm/package.json',
    JSON.stringify({
      name: 'rdrm',
      slicc: {
        commands: { rmd: { abi: 'js', module: 'rm.mjs' }, mkd: { abi: 'js', module: 'mk.mjs' } },
      },
    })
  );
  await kernel.writeFile(
    '/node_modules/rdrm/rm.mjs',
    `export default async function main(ctx) {
  await ctx.fs.writeFile('/root/rd/going', '');
  await ctx.fs.rm('/root/rd/d');
  return 0;
}`
  );
  await kernel.writeFile(
    '/node_modules/rdrm/mk.mjs',
    `export default async function main(ctx) {
  await ctx.fs.mkdir('/root/rd/d');
  await ctx.fs.writeFile('/root/rd/d/b', 'v' + ctx.argv[1] + '\\n');
  return 0;
}`
  );
  const script = [
    'mkdir -p /root/rd && cd /root/rd',
    'for i in $(seq 20); do',
    '  mkd $i && rm -f going && read v < d/b',
    '  rmd & until [ -e going ]; do :; done',
    '  { sleep 0; read v <&3 2> err; rc=$?; echo "$i [$v] rc=$rc fd=$(stat -L -c %s /dev/fd/3)"; [ $rc = 0 ] || echo "$i detail err=[$(cat err)] link=$(readlink /proc/self/fd/3) name=$(stat -c \'%i %s\' d/b) round=$(ls -a)"; } 2> /dev/null 3< d/b',
    '  wait',
    'done',
  ].join('\n');
  const r = await kernel.run(['bash', '-c', script], { cwd: '/' });
  const lines = String(r.stdout).split('\n').filter(Boolean);
  const failedRead = new Set(
    lines.map((line) => /^(\d+) detail err=\[[^\]]*read error/.exec(line)?.[1]).filter(Boolean)
  );
  const bad = lines.filter((line) => {
    if (/^(\d+) \[v\1\] rc=0 fd=\d+$/.test(line)) return false;
    const round = /^(\d+) (?:\[\] rc=1 fd=|detail )/.exec(line)?.[1];
    return round === undefined || !failedRead.has(round);
  });
  assert.deepEqual({ status: r.status, bad }, { status: 0, bad: [] }, String(r.stdout));
});
