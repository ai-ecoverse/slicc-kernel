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

const PACKAGE = JSON.stringify({
  name: 'reach',
  slicc: { commands: { reach: { abi: 'js', module: 'bin/reach.mjs' } } },
});

const PROGRAM = `export default async function main(ctx) {
  const listener = await ctx.net.listen({ port: 7411 });
  const served = (async () => {
    for await (const c of listener) {
      const w = c.writable.getWriter();
      await w.write(new TextEncoder().encode('hi'));
      await w.close();
      await c.close();
    }
  })();
  const out = [];
  for (const name of ctx.argv.slice(1)) {
    try {
      const c = await ctx.net.connect({ host: name, port: 7411 });
      const r = await c.readable.getReader().read();
      out.push(name + ' ' + new TextDecoder().decode(r.value));
      await c.close();
    } catch (e) {
      out.push(name + ' ' + (e.code ?? e.name));
    }
  }
  await listener.close();
  await served.catch(() => undefined);
  await ctx.write(1, out.join('\\n') + '\\n');
}
`;

test('the kernel resolver honours names added to a real /etc/hosts, sees a change at once, and drops them with the file (#898)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile('/node_modules/reach/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/reach/bin/reach.mjs', PROGRAM);
  const reach = async (...names) => (await kernel.run(['reach', ...names], { cwd: '/' })).stdout;
  const sh = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  const before = await reach('zzydb', 'localhost');
  assert.match(before, /^zzydb (?!hi)/);
  assert.match(before, /\nlocalhost hi\n$/);
  await sh("echo '127.0.0.1 zzydb zzydb.internal # added' >> /etc/hosts");
  assert.equal(
    await reach('zzydb', 'ZZYDB.internal.', 'localhost'),
    'zzydb hi\nZZYDB.internal. hi\nlocalhost hi\n'
  );
  await sh("echo '127.0.0.1 later' >> /etc/hosts");
  assert.equal(await reach('later'), 'later hi\n');
  await sh('rm /etc/hosts');
  assert.match(await reach('zzydb', 'localhost'), /^zzydb (?!hi).*\nlocalhost hi\n$/);
});
