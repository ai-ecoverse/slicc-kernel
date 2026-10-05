import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('ripgrep, a WASI program, searches files bash wrote', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasi-ripgrep');

  assert.deepEqual(
    await bash('mkdir -p src && printf "alpha\\nneedle here\\n" > src/a.txt && rg -n needle src'),
    ok('src/a.txt:2:needle here\n')
  );
  assert.deepEqual(page.errors, []);
});

test('WASIX python runs threads and imports numpy through the dynamic linker', async (t) => {
  const { page, run } = await booted(chrome, t);
  await installPackage(page, 'wasix-python');
  await installPackage(page, 'py-numpy');

  const threads =
    'import threading\nout=[]\nts=[threading.Thread(target=lambda i=i: out.append(i*i)) for i in range(4)]\n[t.start() for t in ts]\n[t.join() for t in ts]\nprint(sorted(out))';
  assert.deepEqual(await run(['python3', '-c', threads], { cwd: '/home' }), ok('[0, 1, 4, 9]\n'));
  const numpy = 'import numpy as np\nprint(np.arange(6).reshape(2,3).sum(axis=0).tolist())';
  assert.deepEqual(
    await run(['python3', '-c', numpy], {
      cwd: '/home',
      env: { PYTHONPATH: '/node_modules/@ai-ecoverse/py-numpy/lib/python3.14/site-packages' },
    }),
    ok('[3, 5, 7]\n')
  );
});

test('a WASI client (python urllib) fetches registry metadata through the realm proxy', async (t) => {
  const { page, run } = await booted(chrome, t);
  await installPackage(page, 'wasix-python');

  const code =
    "import json, urllib.request\nwith urllib.request.urlopen('https://registry.npmjs.org/@ai-ecoverse/wasm-bash/latest') as r:\n    print(json.load(r)['name'])";
  assert.deepEqual(
    await run(['python3', '-c', code], { cwd: '/home' }),
    ok('@ai-ecoverse/wasm-bash\n')
  );
});

test('zig builds a program and runs it', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasi-zig');
  const source =
    'const std = @import("std");\npub fn main() void {\n    std.debug.print("hello from zig\\n", .{});\n}\n';
  await page.evaluate((s) => window.opfs.write('home/z/hello.zig', s), source);

  assert.deepEqual(
    await bash('cd /home/z && zig build-exe hello.zig && ./hello.wasm 2>&1'),
    ok('hello from zig\n')
  );
});

test('rustc compiles hello, and cargo builds a crate offline', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasi-rustc');
  await installPackage(page, 'wasi-cargo');

  const script = [
    'mkdir -p /home/r && cd /home/r',
    'printf \'fn main() { println!("hello from rustc"); }\\n\' > hello.rs',
    'rustc hello.rs -o hello.wasm && ./hello.wasm',
    'mkdir -p /home/c/src && cd /home/c',
    'printf \'[package]\\nname = "c"\\nversion = "0.1.0"\\nedition = "2021"\\n\' > Cargo.toml',
    'printf \'fn main() { println!("hello from cargo"); }\\n\' > src/main.rs',
    'cargo build --offline -q && ./target/wasm32-wasip1/debug/c.wasm',
  ].join(' && ');
  assert.deepEqual(
    await bash(script, { cwd: '/home' }),
    ok('hello from rustc\nhello from cargo\n')
  );
});
