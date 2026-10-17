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
  name: 'nodeprobe',
  slicc: { commands: { nodeprobe: { abi: 'js', module: 'bin/nodeprobe.mjs' } } },
});

const PROGRAM = `export default async function main(ctx) {
  const out = [];
  for (const path of ctx.argv.slice(1)) {
    for (const [what, run] of [
      ['writeFile', () => ctx.fs.writeFile(path, 'sneak')],
      ['readFile', () => ctx.fs.readFile(path)],
    ]) {
      try {
        await run();
        out.push(path + ' ' + what + ' ok');
      } catch (e) {
        out.push(path + ' ' + what + ' ' + (e.code ?? e.name));
      }
    }
  }
  await ctx.write(1, out.join('\\n') + '\\n');
}
`;

const PY_OPEN = `import errno, sys
for path in sys.argv[1:]:
    for mode in ['rb', 'ab']:
        try:
            open(path, mode).close()
            print(path, mode, 'ok')
        except OSError as e:
            print(path, mode, errno.errorcode.get(e.errno, e.errno))
`;

const PY_BIND = `import socket
socket.socket(socket.AF_UNIX).bind('/tmp/s.sock')
`;

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.writeFile('/node_modules/nodeprobe/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/nodeprobe/bin/nodeprobe.mjs', PROGRAM);
  await kernel.writeFile('/opt/open.py', PY_OPEN);
  await kernel.writeFile('/opt/bind.py', PY_BIND);
  const sh = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  await sh('mkfifo /tmp/f && python3 /opt/bind.py');
  return { kernel, sh };
}

const kinds = (sh) => sh("stat -c '%F %s' /tmp/f /tmp/s.sock");

test("a FIFO or socket node read or written by a JS program's ctx.fs or the kernel API is ENXIO, and the node is left as it was (#908)", async (t) => {
  const { kernel, sh } = await booted(t);
  assert.equal((await kinds(sh)).stdout, 'fifo 0\nsocket 0\n');
  assert.deepEqual(await kernel.run(['nodeprobe', '/tmp/f', '/tmp/s.sock'], { cwd: '/' }), {
    status: 0,
    stdout: [
      '/tmp/f writeFile ENXIO',
      '/tmp/f readFile ENXIO',
      '/tmp/s.sock writeFile ENXIO',
      '/tmp/s.sock readFile ENXIO',
      '',
    ].join('\n'),
    stderr: '',
  });
  for (const path of ['/tmp/f', '/tmp/s.sock']) {
    await assert.rejects(kernel.writeFile(path, 'x'), /ENXIO/);
    await assert.rejects(kernel.readFile(path), /ENXIO/);
  }
  assert.equal((await kinds(sh)).stdout, 'fifo 0\nsocket 0\n');
  assert.deepEqual(await sh('echo through > /tmp/f & cat /tmp/f; wait'), {
    status: 0,
    stdout: 'through\n',
    stderr: '',
  });
});

test('a WASI program opening a socket node is ENXIO, while its FIFO open still goes through the kernel (#908)', async (t) => {
  const { sh } = await booted(t);
  assert.deepEqual(await sh('python3 /opt/open.py /tmp/s.sock'), {
    status: 0,
    stdout: '/tmp/s.sock rb ENXIO\n/tmp/s.sock ab ENXIO\n',
    stderr: '',
  });
  assert.deepEqual(
    await sh("echo py > /tmp/f & python3 -c \"print(open('/tmp/f').read(), end='')\"; wait"),
    {
      status: 0,
      stdout: 'py\n',
      stderr: '',
    }
  );
  assert.equal((await kinds(sh)).stdout, 'fifo 0\nsocket 0\n');
});
