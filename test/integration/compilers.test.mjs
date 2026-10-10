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

async function kernelWith(...names) {
  const kernel = await createNodeKernel();
  for (const name of ['wasm-bash', 'wasm-coreutils', ...names]) await install(kernel, name);
  return kernel;
}

test('zig builds and runs a program', async () => {
  const kernel = await kernelWith('wasi-zig');
  try {
    const w = await kernel.run(
      [
        'bash',
        '-c',
        'mkdir -p /home/z && cd /home/z && printf \'const std = @import("std");\\npub fn main() void { std.debug.print("hello from zig\\\\n", .{}); }\\n\' > hello.zig && zig build-exe hello.zig && ./hello.wasm; echo "rc=$?"',
      ],
      { cwd: '/home' }
    );
    assert.equal(w.stderr, 'hello from zig\n');
    assert.equal(w.stdout, 'rc=0\n');
  } finally {
    kernel.terminate();
  }
});

test('rustc and cargo build and run programs', async () => {
  const kernel = await kernelWith('wasi-rustc', 'wasi-cargo');
  try {
    const w = await kernel.run(
      [
        'bash',
        '-c',
        [
          'mkdir -p /home/r && cd /home/r',
          'printf \'fn main() { println!("hello from rustc"); }\\n\' > hello.rs',
          'rustc hello.rs -o hello.wasm && ./hello.wasm',
          'mkdir -p /home/c/src && cd /home/c',
          'printf \'[package]\\nname = "c"\\nversion = "0.1.0"\\nedition = "2021"\\n\' > Cargo.toml',
          'printf \'fn main() { println!("hello from cargo"); }\\n\' > src/main.rs',
          'cargo build --offline -q && ./target/wasm32-wasip1/debug/c.wasm; echo "rc=$?"',
        ].join(' && '),
      ],
      { cwd: '/home' }
    );
    assert.equal(w.stderr, '');
    assert.equal(w.stdout, 'hello from rustc\nhello from cargo\nrc=0\n');
  } finally {
    kernel.terminate();
  }
});
