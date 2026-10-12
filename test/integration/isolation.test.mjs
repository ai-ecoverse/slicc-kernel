import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import wabtInit from 'wabt';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('the test page and its nested dedicated workers can block on Atomics.wait', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => typeof window.probe === 'function');

  const report = await page.evaluate(() => window.probe());
  assert.deepEqual(report, {
    isolated: true,
    workers: [
      { isolated: true, wait: 'timed-out' },
      { isolated: true, wait: 'timed-out' },
    ],
  });
  assert.deepEqual(page.errors, []);
});

const PROBE = `(() => {
  const names = ['indexedDB', 'caches', 'cookieStore', 'BroadcastChannel', 'Worker', 'SharedWorker',
    'importScripts', 'XMLHttpRequest', 'postMessage', 'fetch', 'WebSocket', 'webkitRequestFileSystem',
    'webkitRequestFileSystemSync', 'webkitResolveLocalFileSystemURL', 'webkitResolveLocalFileSystemSyncURL'];
  const inherited = (o, n) => {
    for (let p = Object.getPrototypeOf(o); p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, n);
      if (d) return d.get ? d.get.call(o) : d.value;
    }
  };
  const seen = names.map((n) => n + '=' + typeof globalThis[n] + '/' + typeof inherited(globalThis, n));
  for (const n of ['storage', 'locks', 'serviceWorker']) {
    seen.push(n + '=' + typeof navigator[n] + '/' + typeof inherited(navigator, n));
  }
  return seen;
})()`;

const WITHHELD = [
  'indexedDB',
  'caches',
  'cookieStore',
  'BroadcastChannel',
  'Worker',
  'SharedWorker',
  'importScripts',
  'XMLHttpRequest',
  'postMessage',
  'fetch',
  'WebSocket',
  'webkitRequestFileSystem',
  'webkitRequestFileSystemSync',
  'webkitResolveLocalFileSystemURL',
  'webkitResolveLocalFileSystemSyncURL',
  'storage',
  'locks',
  'serviceWorker',
].map((n) => `${n}=undefined/undefined`);

const wabt = await wabtInit();
const WASI_EXIT = [
  ...wabt
    .parseWat(
      'exit.wat',
      '(module (import "wasi_snapshot_preview1" "proc_exit" (func $e (param i32))) (memory (export "memory") 1) (func (export "_start") i32.const 0 call $e))'
    )
    .toBinary({}).buffer,
];

test("a user's own Emscripten glue, a WASI imports module and a package driver get the worker locked down: storage, network and workers are undefined, through their prototypes too", async (t) => {
  const { page, bash } = await booted(chrome, t);
  const typed = await page.evaluate(() => {
    const worker = new Worker(
      URL.createObjectURL(new Blob(['postMessage(typeof webkitRequestFileSystemSync)']))
    );
    return new Promise((resolve) => {
      worker.onmessage = ({ data }) => resolve(data);
    });
  });
  assert.equal(typed, 'function');
  await page.evaluate(() => window.kernel.users.add({ name: 'cone' }));
  const files = {
    'tmp/lock/probe': `Module.print(${PROBE}.join(' '));\nthrow new Error('probed');\n`,
    'node_modules/lockprobe/package.json': JSON.stringify({
      name: 'lockprobe',
      slicc: {
        abi: 'wasi',
        commands: { lockwasi: { wasm: 'bin/lockwasi.wasm', imports: 'host/probe.mjs' } },
        filesystems: { lockfs: { module: 'fs.mjs' } },
      },
    }),
    'node_modules/lockprobe/host/probe.mjs': `const seen = ${PROBE};\nexport function createImports(ctx) {\n  if (ctx.tid === 1) ctx.syscall({ op: 'fd-write', fd: 1, body: new TextEncoder().encode(seen.join(' ') + '\\n') });\n  return {};\n}\n`,
    'node_modules/lockprobe/fs.mjs': `const seen = ${PROBE};\nexport default () => ({\n  handlers: {\n    getattr: async (path) => ({ kind: path === '/' ? 'directory' : 'file', size: 0, mtime: 0 }),\n    readdir: async () => seen.map((name) => ({ name, kind: 'file' })),\n  },\n});\n`,
  };
  for (const [path, text] of Object.entries(files)) {
    await page.evaluate(([p, s]) => window.opfs.write(p, s), [path, text]);
  }
  await page.evaluate(
    ([p, b]) => window.opfs.write(p, new Uint8Array(b)),
    ['tmp/lock/probe.wasm', WASI_EXIT]
  );
  await page.evaluate(
    ([p, b]) => window.opfs.write(p, new Uint8Array(b)),
    ['node_modules/lockprobe/bin/lockwasi.wasm', WASI_EXIT]
  );

  const glue = await bash(
    'cp /tmp/lock/probe /tmp/lock/probe.wasm ~ && chmod +x ~/probe && ~/probe',
    { cwd: '/home', user: 'cone' }
  );
  assert.deepEqual(glue.stdout.trim().split(' '), WITHHELD, glue.stderr);

  const imports = await bash('lockwasi; echo "rc=$?"', { cwd: '/home', user: 'cone' });
  assert.deepEqual(imports.stdout.trim().split(/\s+/), [...WITHHELD, 'rc=0'], imports.stderr);

  await bash('mkdir -p /mnt/lock', { cwd: '/home' });
  const spec = { type: 'lockfs', source: '', target: '/mnt/lock' };
  assert.equal((await page.evaluate((s) => window.kernel.mount(s), spec)).state, 'ok');
  const listed = await bash('ls -1 /mnt/lock', { cwd: '/home' });
  assert.deepEqual(listed.stdout.trim().split('\n').sort(), [...WITHHELD].sort(), listed.stderr);
  await page.evaluate(() => window.kernel.umount('/mnt/lock'));
});
