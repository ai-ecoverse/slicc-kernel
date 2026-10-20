import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('./fixtures/exetest/', import.meta.url);

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

test('/proc/self/exe links to the file a program was run from, a copy run by path keeps the argv[0] it was given, and a command from PATH its name (#1264, homescoop#1269)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  for (const file of ['package.json', 'bin/exetest.wasm']) {
    await kernel.writeFile(`/node_modules/exetest/${file}`, await readFile(new URL(file, fixture)));
  }
  const bash = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  assert.deepEqual(
    await bash(
      'mkdir -p /tmp/v/bin && cp /node_modules/exetest/bin/exetest.wasm /tmp/v/bin/prog && exetest && /tmp/v/bin/prog && cd /tmp/v/bin && ./prog && ln -s /tmp/v/bin/prog /tmp/lnk && /tmp/lnk && PATH=/tmp/v/bin:$PATH prog'
    ),
    {
      status: 0,
      stdout: [
        'exe=/node_modules/exetest/bin/exetest.wasm argv0=exetest',
        'exe=/tmp/v/bin/prog argv0=/tmp/v/bin/prog',
        'exe=/tmp/v/bin/prog argv0=./prog',
        'exe=/tmp/v/bin/prog argv0=/tmp/lnk',
        'exe=/tmp/v/bin/prog argv0=prog',
        '',
      ].join('\n'),
      stderr: '',
    }
  );
  assert.deepEqual(
    await bash('readlink /proc/self/exe; readlink /proc/$$/exe; ls /proc/self | tr "\\n" " "'),
    {
      status: 0,
      stdout:
        '/node_modules/@ai-ecoverse/wasm-coreutils/bin/coreutils\n/node_modules/@ai-ecoverse/wasm-bash/bin/bash\ncmdline comm exe fd stat statm status ',
      stderr: '',
    }
  );
});
