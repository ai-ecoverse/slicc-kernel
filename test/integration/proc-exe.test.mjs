import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startProxy } from '@ai-ecoverse/slicc-node';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const fixture = new URL('./fixtures/exetest/', import.meta.url);
const ORIGIN = 'http://localhost:8787';

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
      "p=$(cat /tmp/mixed); tail -n +9 /proc/$p/status | head -1; readlink -v /proc/$p/exe; echo rc=$?; readlink /proc/self/exe; python3 -c \"import os; os.readlink('/proc/$p/exe')\" 2>&1 | tail -1; python3 -c \"open('/proc/$p/exe', 'rb')\" 2>&1 | tail -1",
      'cone'
    ),
    {
      status: 0,
      stdout: `Uid:\t1000\t0\t0\t0\nrc=1\n/node_modules/@ai-ecoverse/wasm-coreutils/bin/coreutils\nPermissionError: [Errno 2] Permission denied: '/proc/1000/exe'\nPermissionError: [Errno 2] Permission denied: '/proc/1000/exe'\n`,
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

test('a WASI program can stat, open and read /proc/self/exe as the program file, while lstat and readlink show the link (#1273)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  const python = '/node_modules/@ai-ecoverse/wasix-python/bin/python.wasm';
  const script = [
    'import os, stat',
    "p = '/proc/self/exe'",
    'print(stat.S_ISLNK(os.lstat(p).st_mode), os.readlink(p))',
    `print(os.stat(p).st_size == os.stat('${python}').st_size, stat.S_ISREG(os.stat(p).st_mode))`,
    "print(open(p, 'rb').read(4))",
    'for mode in (os.O_WRONLY, os.O_RDWR, os.O_RDONLY | os.O_TRUNC):',
    '    try: os.open(p, mode); print("opened")',
    '    except OSError as e: print(e.strerror)',
    `print(os.stat('${python}').st_size == os.stat(p).st_size)`,
  ].join('\n');
  const r = await kernel.run(['python3', '-c', script], { cwd: '/' });
  assert.deepEqual(r, {
    status: 0,
    stdout: `True ${python}\nTrue True\nb'\\x00asm'\n${'Read-only file system\n'.repeat(3)}True\n`,
    stderr: '',
  });
});

test('a symlink to /proc/self/exe opens the program file, and exe keeps to the running file when its name is moved or replaced (#1317)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  const python = '/node_modules/@ai-ecoverse/wasix-python/bin/python.wasm';
  const script = [
    'import os',
    "p = '/proc/self/exe'",
    "os.symlink(p, '/tmp/exe')",
    `print(os.stat('/tmp/exe').st_size == os.stat('${python}').st_size, open('/tmp/exe', 'rb').read(4))`,
    'try: os.open("/tmp/exe", os.O_WRONLY)',
    'except OSError as e: print(e.strerror)',
    'def look():',
    '    try: print(os.readlink(p), os.stat(p).st_size, open(p, "rb").read(4))',
    '    except OSError as e: print(os.readlink(p), e.strerror)',
    `os.rename('${python}', '${python}.old')`,
    'look()',
    `open('${python}', 'wb').write(b'other')`,
    'look()',
    `os.replace('${python}.old', '${python}')`,
    'print(open(p, "rb").read(4))',
  ].join('\n');
  const r = await kernel.run(['python3', '-c', script], { cwd: '/' });
  const gone = `${python} (deleted) No such file or directory\n`;
  assert.deepEqual(r, {
    status: 0,
    stdout: `True b'\\x00asm'\nRead-only file system\n${gone}${gone}b'\\x00asm'\n`,
    stderr: '',
  });
});

test('a WASI program run from a tmpfs or a hostfs mount reads its /proc/self/exe link without "(deleted)" (#1317)', {
  timeout: 300_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-exe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const proxy = await startProxy({
    port: 0,
    origins: [ORIGIN],
    mounts: [`${dir}:project`],
    kernelPort: null,
  });
  t.after(() => proxy.close());
  const hostfs = async (mount, { readonly }) => {
    const response = await fetch(`${proxy.url}/api/hostfs/grant`, {
      method: 'POST',
      headers: { 'X-Bridge-Token': proxy.key, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mount, readonly }),
    });
    const { token, capabilities } = await response.json();
    return { url: proxy.url, token, capabilities };
  };
  const kernel = await createNodeKernel({ hostfs, hostfsOrigin: ORIGIN });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile('/mnt/t/.keep', '');
  await kernel.writeFile('/mnt/h/.keep', '');
  await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/t' });
  await kernel.mount({ type: 'hostfs', source: 'project', target: '/mnt/h' });
  await kernel.writeFile('/mnt/t/prog', await readFile(new URL('bin/exetest.wasm', fixture)));
  await writeFile(join(dir, 'prog'), await readFile(new URL('bin/exetest.wasm', fixture)));
  await utimes(join(dir, 'prog'), 1_700_000_000.123456, 1_700_000_000.123456);
  const r = await kernel.run(
    ['bash', '-c', 'chmod +x /mnt/t/prog /mnt/h/prog; /mnt/t/prog && /mnt/h/prog'],
    {
      cwd: '/',
    }
  );
  assert.deepEqual(r, {
    status: 0,
    stdout: 'exe=/mnt/t/prog argv0=/mnt/t/prog\nexe=/mnt/h/prog argv0=/mnt/h/prog\n',
    stderr: '',
  });
});

test('/proc/self/exe of a program whose directory becomes unsearchable is not deleted: readlink keeps the plain path and following it fails with EACCES (#1329)', {
  timeout: 120_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.users.add({ name: 'cone' });
  const bin = '/node_modules/@ai-ecoverse/wasix-python/bin';
  const script = [
    'import os, time',
    "open('/tmp/x1329/ready', 'w').close()",
    "while not os.path.exists('/tmp/x1329/go'): time.sleep(0.01)",
    "print(os.readlink('/proc/self/exe'))",
    'try:',
    "    os.stat('/proc/self/exe'); print('stat ok')",
    'except OSError as e:',
    '    print(e.strerror)',
  ].join('\n');
  await kernel.run(['bash', '-c', 'rm -rf /tmp/x1329 && mkdir -m 777 /tmp/x1329'], { cwd: '/' });
  const running = kernel.run(['python3', '-c', script], { cwd: '/', user: 'cone' });
  const ready = () =>
    kernel.readFile('/tmp/x1329/ready').then(
      () => true,
      () => false
    );
  while (!(await ready())) await new Promise((resolve) => setTimeout(resolve, 10));
  await kernel.run(['bash', '-c', `chmod 700 ${bin} && touch /tmp/x1329/go`], { cwd: '/' });
  const r = await running;
  await kernel.run(['bash', '-c', `chmod 755 ${bin}`], { cwd: '/' });
  assert.deepEqual(r, { status: 0, stdout: `${bin}/python.wasm\nPermission denied\n`, stderr: '' });
});

for (const when of ['after', 'start', 'removed']) {
  const phrase = {
    after:
      'replaced right after the kernel has read it runs the bytes its /proc/self/exe identity names, never the old bytes under the new identity (#1329)',
    start:
      'replaced as soon as the kernel starts reading it runs the bytes its /proc/self/exe identity names, never the old bytes under the new identity (#1329)',
    removed:
      'removed right after the kernel has read it still starts, from the bytes it read (#1468)',
  }[when];
  test(`a program ${phrase}`, {
    timeout: 120_000,
  }, async (t) => {
    const { memoryRoot } = await import('../../dist/node.js');
    const second = await readFile(new URL('bin/exetest.wasm', fixture));
    const first =
      when === 'removed' ? second : await readFile(new URL('../idtest/bin/idtest.wasm', fixture));
    let swap;
    let reads = 0;

    const wrap = (handle) => {
      if (handle.kind === 'directory')
        return new Proxy(handle, {
          get(target, key) {
            if (key === 'getDirectoryHandle' || key === 'getFileHandle')
              return async (...args) => wrap(await target[key](...args));
            if (key === 'values')
              return async function* () {
                for await (const child of target.values()) yield wrap(child);
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      if (handle.name !== 'prog') return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'getFile')
            return async () => {
              const file = await target.getFile();
              const read = file.arrayBuffer.bind(file);
              file.arrayBuffer = async () => {
                const now = ++reads === 2;
                if (now && when === 'start') await swap?.(target);
                const bytes = await read();
                if (now && when !== 'start') await swap?.(target);
                return bytes;
              };
              return file;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    const kernel = await createNodeKernel({ root: wrap(memoryRoot()) });
    t.after(() => kernel.terminate());
    for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
    await kernel.writeFile('/tmp/p/prog', first);
    await kernel.run(['bash', '-c', 'chmod 755 /tmp/p/prog'], { cwd: '/' });
    swap = async () => {
      swap = undefined;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (when === 'removed') await kernel.run(['rm', '/tmp/p/prog'], { cwd: '/' });
      else await kernel.writeFile('/tmp/p/prog', second);
    };
    const r = await kernel.run(['/tmp/p/prog'], { cwd: '/' });
    const exe = when === 'removed' ? '/tmp/p/prog (deleted)' : '/tmp/p/prog';
    assert.deepEqual(r, { status: 0, stdout: `exe=${exe} argv0=/tmp/p/prog\n`, stderr: '' });
  });
}
