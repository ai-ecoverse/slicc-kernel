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

test("a process cone can see but not trace (root with cone as its real uid) has an exe cone may not readlink, EACCES as on Linux, while root and cone's own processes read theirs (#1264 review)", {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.users.add({ name: 'cone' });
  const held = kernel.run(
    [
      'python3',
      '-c',
      'import os,time; os.setresuid(1000,0,0); open("/tmp/mixed","w").write(str(os.getpid())); os.chmod("/tmp/mixed",0o644); [time.sleep(0.05) for _ in range(600) if not os.path.exists("/tmp/done")]',
    ],
    { cwd: '/' }
  );
  for (;;) {
    const text = await kernel.readFile('/tmp/mixed').catch(() => undefined);
    if (text && text.length > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const python = '/node_modules/@ai-ecoverse/wasix-python/bin/python.wasm';
  const sh = (script, user) =>
    kernel.run(['bash', '-c', script], { cwd: '/', ...(user ? { user } : {}) });
  assert.deepEqual(
    await sh(
      'p=$(cat /tmp/mixed); tail -n +9 /proc/$p/status | head -1; readlink -v /proc/$p/exe; echo rc=$?; readlink /proc/self/exe; python3 -c "import os; os.readlink(\'/proc/$p/exe\')" 2>&1 | tail -1',
      'cone'
    ),
    {
      status: 0,
      stdout: `Uid:\t1000\t0\t0\t0\nrc=1\n/node_modules/@ai-ecoverse/wasm-coreutils/bin/coreutils\nPermissionError: [Errno 2] Permission denied: '/proc/1000/exe'\n`,
      stderr: 'readlink: /proc/1000/exe: Permission denied\n',
    }
  );
  assert.deepEqual(await sh('readlink /proc/$(cat /tmp/mixed)/exe'), {
    status: 0,
    stdout: `${python}\n`,
    stderr: '',
  });
  await kernel.writeFile('/tmp/done', '');
  await held;
});
