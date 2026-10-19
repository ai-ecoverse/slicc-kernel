import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(base, file)}`,
      await readFile(file)
    );
  }
}

const RAW = `const dec = new TextDecoder();
export default async function main(ctx) {
  const got = [];
  ctx.sync.tty.setRaw(0, true);
  await ctx.write(1, 'R>');
  got.push(dec.decode(await ctx.read(0, 16)));
  await ctx.write(1, 'N>');
  got.push(dec.decode(await ctx.read(0, 16)));
  ctx.sync.tty.setRaw(0, false);
  await ctx.write(1, 'C>');
  got.push(dec.decode(await ctx.read(0, 64)));
  await ctx.write(1, '|' + JSON.stringify(got) + '|');
}
`;

async function session(kernel) {
  const term = await kernel.openTerminal(['rawtest'], { cwd: '/' });
  let screen = '';
  const waiters = [];
  term.onData = (bytes) => {
    screen += new TextDecoder().decode(bytes);
    for (const w of waiters.splice(0)) w();
  };
  const until = async (text) => {
    while (!screen.includes(text)) await new Promise((r) => waiters.push(r));
  };
  await until('R>');
  term.write('a');
  await until('N>');
  term.write('b');
  await until('C>');
  const before = screen;
  term.write('xy\r');
  await term.exited;
  return { before, screen };
}

test('ctx.sync.tty.setRaw is in effect before it returns: input typed right after is neither cooked nor echoed, and setRaw(false) brings echo and lines back, under load too (#1109)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await kernel.writeFile(
    '/node_modules/rawtest/package.json',
    JSON.stringify({
      name: 'rawtest',
      slicc: { commands: { rawtest: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/rawtest/main.mjs', RAW);
  const hogs = [0, 1, 2].map(() =>
    kernel.run(['bash', '-c', 'end=$((SECONDS+20)); while [ $SECONDS -lt $end ]; do :; done'])
  );
  for (let i = 0; i < 5; i++) {
    const { before, screen } = await session(kernel);
    assert.equal(before.replaceAll('\r', ''), 'R>N>C>', `round ${i}: nothing echoed while raw`);
    assert.match(screen, /C>xy\r?\n/, `round ${i}: echo is back`);
    assert.match(screen, /\|\["a","b","xy\\n"\]\|/, `round ${i}`);
  }
  await Promise.all(hogs);
});
