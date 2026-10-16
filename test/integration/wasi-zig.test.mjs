import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

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
