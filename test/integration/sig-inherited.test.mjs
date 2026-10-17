import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('./fixtures/inherittest/', import.meta.url);

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

test("a WASIX program's own sigaction reads back the SIG_IGN it inherited across spawn and exec, and SIG_DFL resets it (#820)", {
  timeout: 60_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  for (const file of ['package.json', 'bin/inherittest.wasm']) {
    await kernel.writeFile(
      `/node_modules/inherittest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  const bash = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  const reset = 'after SIG_DFL: SIGPIPE default\n';
  assert.deepEqual(await bash('inherittest'), {
    status: 0,
    stdout: `SIGPIPE default, SIGHUP default, SIGINT default\n${reset}`,
    stderr: '',
  });
  assert.deepEqual(await bash("trap '' PIPE HUP; inherittest"), {
    status: 0,
    stdout: `SIGPIPE ignored, SIGHUP ignored, SIGINT default\n${reset}`,
    stderr: '',
  });
  assert.deepEqual(await bash("trap '' PIPE; bash -c 'exec inherittest'"), {
    status: 0,
    stdout: `SIGPIPE ignored, SIGHUP default, SIGINT default\n${reset}`,
    stderr: '',
  });
  assert.deepEqual(await bash("trap '' PIPE; trap - PIPE; inherittest"), {
    status: 0,
    stdout: `SIGPIPE default, SIGHUP default, SIGINT default\n${reset}`,
    stderr: '',
  });
});
