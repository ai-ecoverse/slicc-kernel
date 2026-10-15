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

const PROGRAM = `const text = (b) => new TextDecoder().decode(b);
export default async function main(ctx) {
  const c = await ctx.spawn({ argv: ['bash', '-c', 'read -r go; exec sleep 0'], stdin: 'pipe', stdout: 'null' });
  const read = () => {
    let line;
    try {
      line = text(ctx.sync.fs.readFile('/proc/' + c.pid + '/stat'));
    } catch (e) {
      return 'error ' + e.code;
    }
    const f = line.replace(/^.*\\) /, '').split(' ');
    const whole = line.startsWith(c.pid + ' (') && f.length > 40 && f[1] === String(ctx.pid);
    return whole ? line.slice(line.indexOf('(') + 1, line.indexOf(')')) + ' ' + f[0] : line.slice(0, 40);
  };
  const seen = [read()];
  const w = c.stdin.getWriter();
  await w.write(new TextEncoder().encode('go\\n'));
  await w.close();
  const until = Date.now() + 60000;
  while (Date.now() < until && seen.at(-1) !== 'sleep Z') {
    const now = read();
    if (now !== seen.at(-1)) seen.push(now);
  }
  await c.wait();
  await ctx.write(1, JSON.stringify(seen.filter((s) => s !== 'sleep S' && s !== 'sleep R')));
}
`;

test('/proc/<pid>/stat of a child that exec\u2019d reads whole all its life, as a zombie until it is waited for', async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  await kernel.writeFile(
    '/node_modules/pstat/package.json',
    JSON.stringify({
      name: 'pstat',
      slicc: { commands: { pstat: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/pstat/main.mjs', PROGRAM);
  const r = await kernel.run(['pstat'], { cwd: '/' });
  assert.deepEqual(JSON.parse(r.stdout), ['bash S', 'sleep Z']);
});
