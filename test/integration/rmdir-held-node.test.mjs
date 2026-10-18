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
    'mkdir -p /root/rd/d && echo v0 > /root/rd/d/a && echo v0 > /root/rd/d/b && : > /root/rd/err',
    'cd /root/rd',
    '(while [ ! -e stop ]; do cat d/a > /dev/null 2>&1; done) &',
    `for r in $(seq ${READERS}); do (while [ ! -e stop ]; do { sleep 0.005; read -r v <&3; case "$v" in v[0-9]*) ;; *) echo "bad [$v]" >> err;; esac; } 2> /dev/null 3< d/b; done) & done`,
    'rdrm',
    'echo "replaced $?"',
    'wait',
    'cat err',
  ].join('\n');
  const r = await kernel.run(['bash', '-c', script], { cwd: '/' });
  assert.equal(String(r.stdout), 'replaced 0\n', String(r.stderr));
});
