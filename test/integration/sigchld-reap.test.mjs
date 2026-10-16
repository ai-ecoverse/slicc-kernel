import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('fixtures/reaptest/', import.meta.url);

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

async function booted(t) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const file of ['package.json', 'bin/reaptest.wasm']) {
    await kernel.writeFile(
      `/node_modules/reaptest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  await install(kernel, 'wasm-bash');
  return kernel;
}

const ok = (stdout) => ({ status: 0, stdout, stderr: '' });

test('with SIGCHLD ignored, or SA_NOCLDWAIT, exited children are reaped at once and wait gives ECHILD once all have exited; the default, or an explicit SIG_DFL, leaves a waitable zombie (#820)', async (t) => {
  const kernel = await booted(t);
  const run = (mode) => kernel.run(['reaptest', mode], { cwd: '/' });
  assert.deepEqual(
    await run('ign'),
    ok(
      'ign: exited child already reaped (ECHILD)\nign: wait ECHILD after all children, once both had exited\n'
    )
  );
  assert.deepEqual(
    await run('nocldwait'),
    ok(
      'nocldwait: exited child already reaped (ECHILD)\nnocldwait: wait ECHILD after all children, once both had exited\n'
    )
  );
  assert.deepEqual(
    await run('dfl'),
    ok('dfl: exited child waitable, status 3\ndfl: wait returned a child\n')
  );
  assert.deepEqual(
    await run('reset'),
    ok('reset: exited child waitable, status 3\nreset: wait returned a child\n')
  );
});

test('slicc.sigaction_inherited reports the SIG_IGN dispositions a program inherited across spawn, and an inherited SIGCHLD ignore reaps from the start (#820)', async (t) => {
  const kernel = await booted(t);
  assert.deepEqual(
    await kernel.run(['bash', '-c', `trap '' PIPE CHLD; reaptest inherited`], { cwd: '/' }),
    ok(
      [
        'inherited: ok, SIGPIPE ignored, SIGCHLD ignored, SIGTERM default',
        'inherited: exited child already reaped (ECHILD)',
        'inherited: wait ECHILD after all children, once both had exited',
        '',
      ].join('\n')
    )
  );
  assert.deepEqual(
    await kernel.run(['bash', '-c', 'reaptest inherited'], { cwd: '/' }),
    ok(
      [
        'inherited: ok, SIGPIPE default, SIGCHLD default, SIGTERM default',
        'inherited: exited child waitable, status 3',
        'inherited: wait returned a child',
        '',
      ].join('\n')
    )
  );
});
