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

test('a package glue with no wasm beside it runs by path as the command that owns it (#390)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  const core = new URL('wasm-coreutils/bin/', modules);
  await kernel.writeFile(
    '/node_modules/gluepkg/bin/tool',
    await readFile(new URL('coreutils', core))
  );
  await kernel.writeFile(
    '/node_modules/gluepkg/bin/engine.wasm',
    await readFile(new URL('coreutils.wasm', core))
  );
  await kernel.writeFile(
    '/node_modules/gluepkg/package.json',
    JSON.stringify({
      name: 'gluepkg',
      slicc: {
        commands: {
          tool: { glue: 'bin/tool', wasm: 'bin/engine.wasm', argv0: 'echo' },
          zz: { glue: 'bin/tool', wasm: 'bin/engine.wasm', argv0: 'false' },
        },
      },
    })
  );
  await kernel.users.add({ name: 'cone' });
  const script =
    '/node_modules/gluepkg/bin/tool by path; echo rc=$?; cd /node_modules/gluepkg/bin && ./tool relative; cp tool /tmp/tool$$ && /tmp/tool$$ copied; echo rc=$?';
  for (const user of [undefined, 'cone']) {
    const r = await kernel.run(['bash', '-c', script], { cwd: '/', ...(user ? { user } : {}) });
    assert.equal(r.stdout, 'by path\nrc=0\nrelative\nrc=2\n', `${user ?? 'root'}: ${r.stderr}`);
    assert.match(r.stderr, /\/tmp\/tool\d+: line \d+: syntax error/);
  }
});
