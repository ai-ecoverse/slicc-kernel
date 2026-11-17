import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import wabtInit from 'wabt';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const sleeploop = new URL('./fixtures/sleeploop/bin/sleeploop.wasm', import.meta.url);
const BASH = '/node_modules/@ai-ecoverse/wasm-bash/bin';
const W = '/node_modules/xsh/bin/bash.wasm';
const same = (a, b) => `[ "$(sha256sum < ${a})" = "$(sha256sum < ${b})" ]`;

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

const WRITER = `export default async function main(ctx) {
  const at = ctx.argv[ctx.argv.length - 1];
  const tried = async (op) => op().then(() => 'written', (err) => err.code);
  const opened = await tried(() => ctx.open(at, { write: true }));
  const written = await tried(() => ctx.fs.writeFile(at, 'x'));
  const synced = await tried(async () => ctx.sync.fs.writeFile(at, 'x'));
  await ctx.write(1, \`open \${opened}\\nwriteFile \${written}\\nsync \${synced}\\n\`);
  return 0;
}`;

const PYTHON = [
  'import errno, os, sys',
  'at = sys.argv[1]',
  'for name, op in [("open", lambda: os.close(os.open(at, os.O_WRONLY))), ("truncate", lambda: os.truncate(at, 0))]:',
  '    try:',
  '        op()',
  '        print(name, "written")',
  '    except OSError as e:',
  '        print(name, errno.errorcode[e.errno], e.strerror)',
].join('\n');

const opener = (oflags, rights) => `(module
  (import "wasi_snapshot_preview1" "path_open" (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 16) "${W.slice(1)}")
  (func (export "_start")
    (call $exit (call $open (i32.const 3) (i32.const 0) (i32.const 16) (i32.const ${W.length - 1}) (i32.const ${oflags}) (i64.const ${rights}) (i64.const ${rights}) (i32.const 0) (i32.const 64)))))`;

async function openers(kernel) {
  const wabt = await wabtInit();
  const commands = {};
  for (const [name, oflags, rights] of [
    ['wtrunc', 8, 64],
    ['wonly', 0, 64],
    ['ronly', 0, 2],
  ]) {
    const mod = wabt.parseWat(`${name}.wat`, opener(oflags, rights));
    await kernel.writeFile(
      `/node_modules/openers/${name}.wasm`,
      new Uint8Array(mod.toBinary({}).buffer)
    );
    mod.destroy();
    commands[name] = { wasm: `${name}.wasm` };
  }
  await kernel.writeFile(
    '/node_modules/openers/package.json',
    JSON.stringify({ name: 'openers', slicc: { abi: 'wasi', commands } })
  );
}

async function booted(t, users = 'enforce') {
  const kernel = await createNodeKernel({ users });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.writeFile(
    '/node_modules/xsh/package.json',
    JSON.stringify({
      name: 'xsh',
      slicc: { abi: 'emscripten', commands: { xsh: { glue: 'bin/bash', wasm: 'bin/bash.wasm' } } },
    })
  );
  await kernel.writeFile(
    '/node_modules/jswriter/package.json',
    JSON.stringify({
      name: 'jswriter',
      slicc: { commands: { jswriter: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/jswriter/main.mjs', WRITER);
  await kernel.writeFile('/tmp/write.py', PYTHON);
  await openers(kernel);
  const sh = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  const made = await sh(
    `mkdir -p /node_modules/xsh/bin && cp ${BASH}/bash /node_modules/xsh/bin/bash && cp ${BASH}/bash.wasm ${W} && cp ${BASH}/bash.wasm /tmp/orig.wasm && { cat ${BASH}/bash.wasm; printf new; } > /tmp/new.wasm`
  );
  assert.equal(made.status, 0, made.stderr);
  return { kernel, sh };
}

const WAIT = ': > /tmp/up; while [ ! -e /tmp/go ]; do sleep 0.05; done; echo ended';

async function running(kernel, sh, argv = ['xsh', '-c', WAIT]) {
  await sh('rm -f /tmp/up /tmp/go');
  const ended = kernel.run(argv, { cwd: '/' });
  let early;
  ended.then(
    (r) => {
      early = r;
    },
    (err) => {
      early = err;
    }
  );
  while ((await sh('test -e /tmp/up')).status !== 0) {
    assert.equal(early, undefined, 'xsh ended before it was up');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return async () => {
    await sh(': > /tmp/go');
    const r = await ended;
    assert.deepEqual(r, { status: 0, stdout: 'ended\n', stderr: '' });
  };
}

const BUSY = [
  `cat /tmp/new.wasm > ${W}`,
  `cp /tmp/new.wasm ${W}`,
  `truncate -s 0 ${W}`,
  `echo x >> ${W}`,
  `exec 3<> ${W}`,
  `ln -sf ${W} /tmp/link && echo x > /tmp/link`,
  `ln -sfn /node_modules/xsh/bin /tmp/dir && echo x > /tmp/dir/bash.wasm`,
];

for (const users of ['enforce', 'off']) {
  test(`opening a running program's wasm for writing fails with ETXTBSY in bash, coreutils, WASI, JS and the kernel API, reads still work, and the write works once it ends (users: ${users})`, {
    timeout: 300_000,
  }, async (t) => {
    const { kernel, sh } = await booted(t, users);
    const end = await running(kernel, sh);
    for (const script of BUSY) {
      const r = await sh(`${script}; echo "rc=$?"`);
      assert.match(r.stdout, /rc=1\n$/, `${script}: ${JSON.stringify(r)}`);
      assert.match(r.stderr, /Text file busy/, `${script}: ${JSON.stringify(r)}`);
    }
    assert.deepEqual(await kernel.run(['python3', '/tmp/write.py', W], { cwd: '/' }), {
      status: 0,
      stdout: 'open ETXTBSY Text file busy\ntruncate ETXTBSY Text file busy\n',
      stderr: '',
    });
    assert.deepEqual(
      await sh('wtrunc; echo "trunc $?"; wonly; echo "write $?"; ronly; echo "read $?"'),
      {
        status: 0,
        stdout: 'trunc 74\nwrite 74\nread 0\n',
        stderr: '',
      }
    );
    assert.deepEqual(await kernel.run(['jswriter', W], { cwd: '/' }), {
      status: 0,
      stdout: 'open ETXTBSY\nwriteFile ETXTBSY\nsync ETXTBSY\n',
      stderr: '',
    });
    const embedder = await kernel.writeFile(W, 'x').then(
      () => 'written',
      (err) => err.code
    );
    assert.equal(embedder, 'ETXTBSY');
    assert.deepEqual(await sh(`${same(W, '/tmp/orig.wasm')} && echo same`), {
      status: 0,
      stdout: 'same\n',
      stderr: '',
    });
    await end();
    assert.deepEqual(
      await sh(`cp /tmp/new.wasm ${W} && ${same(W, '/tmp/new.wasm')} && echo copied`),
      {
        status: 0,
        stdout: 'copied\n',
        stderr: '',
      }
    );
    await kernel.writeFile(W, await readFile(`${fileURLToPath(modules)}wasm-bash/bin/bash.wasm`));
    assert.deepEqual(await kernel.run(['xsh', '-c', 'echo again'], { cwd: '/' }), {
      status: 0,
      stdout: 'again\n',
      stderr: '',
    });
  });
}

test("a running program's wasm can be removed or renamed over and then written, as on Linux; a name it was moved to is busy", {
  timeout: 300_000,
}, async (t) => {
  const { kernel, sh } = await booted(t);
  const end = await running(kernel, sh);
  const replaced = await sh(
    [
      `rm ${W} && cp /tmp/new.wasm ${W} && echo removed-then-written`,
      `cat /tmp/orig.wasm > ${W} && echo written-again`,
    ].join('; ')
  );
  assert.deepEqual(replaced, {
    status: 0,
    stdout: 'removed-then-written\nwritten-again\n',
    stderr: '',
  });
  await end();
  const end2 = await running(kernel, sh);
  const moved = await sh(
    [
      `mv ${W} /node_modules/xsh/bin/old.wasm && cp /tmp/new.wasm ${W} && echo old-name-free`,
      'echo x > /node_modules/xsh/bin/old.wasm; echo "moved rc=$?"',
      `cp /tmp/new.wasm /tmp/over.wasm && mv /tmp/over.wasm /node_modules/xsh/bin/old.wasm && echo renamed-over`,
      'echo x > /node_modules/xsh/bin/old.wasm && echo written-after-rename-over',
    ].join('; ')
  );
  assert.equal(
    moved.stdout,
    'old-name-free\nmoved rc=1\nrenamed-over\nwritten-after-rename-over\n',
    JSON.stringify(moved)
  );
  assert.match(moved.stderr, /old\.wasm: Text file busy/);
  await end2();
});

test('a WASI program on a tmpfs mount is busy under each of its hard links while it runs, even stopped, and free once it ends', {
  timeout: 300_000,
}, async (t) => {
  const { kernel, sh } = await booted(t);
  await kernel.writeFile('/tmp/sleeploop.wasm', await readFile(sleeploop));
  await sh('mkdir -p /mnt/t');
  await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/t' });
  const r = await sh(
    [
      'cp /tmp/sleeploop.wasm /mnt/t/a.wasm && chmod 755 /mnt/t/a.wasm && ln /mnt/t/a.wasm /mnt/t/b.wasm',
      'rm -f /tmp/sleeploop.ready; /mnt/t/a.wasm 200 & while [ ! -s /tmp/sleeploop.ready ]; do sleep 0.02; done',
      'kill -STOP $!',
      'echo x > /mnt/t/b.wasm; echo "link rc=$?"',
      'echo x >> /mnt/t/a.wasm; echo "name rc=$?"',
      `${same('/mnt/t/b.wasm', '/tmp/sleeploop.wasm')} && echo readable`,
      'kill -CONT $!; wait $!; echo "ran rc=$?"',
      'echo x > /mnt/t/b.wasm && echo written',
    ].join('\n')
  );
  assert.equal(
    r.stdout.replace(/^slept.*\n/m, ''),
    'link rc=1\nname rc=1\nreadable\nran rc=0\nwritten\n',
    JSON.stringify(r)
  );
  assert.equal(r.stderr.match(/Text file busy/g)?.length, 2, r.stderr);
});

test("a running program's wasm is free once its process execs another program, and stays busy while it execs itself", {
  timeout: 300_000,
}, async (t) => {
  const { kernel, sh } = await booted(t);
  const itself = await running(kernel, sh, ['xsh', '-c', `exec xsh -c '${WAIT}'`]);
  const busy = await sh(`cp /tmp/new.wasm ${W}; echo "rc=$?"`);
  assert.equal(busy.stdout, 'rc=1\n', JSON.stringify(busy));
  assert.match(busy.stderr, /Text file busy/);
  await itself();
  const other = await running(kernel, sh, ['xsh', '-c', `exec bash -c '${WAIT}'`]);
  assert.deepEqual(await sh(`cp /tmp/new.wasm ${W} && echo free`), {
    status: 0,
    stdout: 'free\n',
    stderr: '',
  });
  await other();
});
