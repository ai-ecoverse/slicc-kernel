import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('./fixtures/esiginherit/', import.meta.url);

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

test("an Emscripten program's own sigaction reads back the SIG_IGN it inherited, through Module.sliccKernel.sigInherited (#965)", {
  timeout: 60_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await kernel.writeFile(
    '/node_modules/esiginherit/package.json',
    await readFile(new URL('package.json', fixture))
  );
  for (const file of ['bin/esiginherit', 'bin/esiginherit.wasm']) {
    await kernel.writeFile(
      `/node_modules/esiginherit/${file}`,
      await readFile(new URL(file, fixture)),
      {
        mode: 0o755,
      }
    );
  }
  const bash = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  assert.deepEqual(await bash('esiginherit'), {
    status: 0,
    stdout: 'SIGPIPE default, SIGHUP default, SIGINT default\n',
    stderr: '',
  });
  assert.deepEqual(await bash("trap '' PIPE HUP; esiginherit; bash -c 'exec esiginherit'"), {
    status: 0,
    stdout:
      'SIGPIPE ignored, SIGHUP ignored, SIGINT default\nSIGPIPE ignored, SIGHUP ignored, SIGINT default\n',
    stderr: '',
  });
});
