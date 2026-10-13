import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const bashDir = process.env.SLICC_WASM_BASH
  ? `${process.env.SLICC_WASM_BASH.replace(/\/$/, '')}/`
  : new URL('../../node_modules/@ai-ecoverse/wasm-bash/', import.meta.url).pathname;

async function bashBuild() {
  const { version } = JSON.parse(await readFile(join(bashDir, 'package.json'), 'utf8'));
  const [, base, build] = /^(\d+\.\d+\.\d+)-(\d+)$/.exec(version) ?? [];
  return base === '5.3.0' ? Number(build) : base ? Number.POSITIVE_INFINITY : 0;
}

const PROGRAM = `const text = (b) => new TextDecoder().decode(b);
export default async function main(ctx) {
  const script = ctx.argv[1];
  const child = await ctx.spawn({ argv: ['bash', '-c', script], stdout: 'pipe' });
  const [out, waited] = await Promise.all([new Response(child.stdout).text(), child.wait()]);
  const run = ctx.sync.run({ argv: ['bash', '-c', script] });
  await ctx.write(1, JSON.stringify({
    wait: [waited.status, waited.signal ?? null, out],
    run: [run.status, run.signal ?? null, text(run.stdout)],
  }));
  return 0;
}
`;

async function kernelWithBash() {
  const kernel = await createNodeKernel();
  const entries = await readdir(bashDir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/wasm-bash/${relative(bashDir, file)}`,
      await readFile(file)
    );
  }
  await kernel.writeFile(
    '/node_modules/selfkill/package.json',
    JSON.stringify({
      name: 'selfkill',
      slicc: { commands: { selfkill: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/selfkill/main.mjs', PROGRAM);
  return kernel;
}

test('bash that signals itself ends by the signal, for ctx.spawn and ctx.sync.run (#422)', async (t) => {
  if ((await bashBuild()) < 18) {
    t.skip('needs @ai-ecoverse/wasm-bash 5.3.0-18 or later (or SLICC_WASM_BASH)');
    return;
  }
  const kernel = await kernelWithBash();
  const outcome = async (script) => JSON.parse((await kernel.run(['selfkill', script])).stdout);
  assert.deepEqual(await outcome('kill -TERM $$; echo after'), {
    wait: [143, 15, ''],
    run: [null, 15, ''],
  });
  assert.deepEqual(await outcome('kill -KILL $$; echo after'), {
    wait: [137, 9, ''],
    run: [null, 9, ''],
  });
  assert.deepEqual(await outcome('trap "echo t" TERM; kill -TERM $$; echo after'), {
    wait: [0, null, 't\nafter\n'],
    run: [0, null, 't\nafter\n'],
  });
  assert.deepEqual(await outcome('exit 143'), {
    wait: [143, null, ''],
    run: [143, null, ''],
  });
});
