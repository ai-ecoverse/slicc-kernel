import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { pageBash, processTree, progressing } from './progress.mjs';

const chrome = await launch();
after(() => chrome.close());

test('zig builds a program and runs it', { timeout: 400_000 }, async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasi-zig');
  const source =
    'const std = @import("std");\npub fn main() void {\n    std.debug.print("hello from zig\\n", .{});\n}\n';
  await page.evaluate((s) => window.opfs.write('home/z/hello.zig', s), source);

  const built = progressing(
    pageBash(page, 'cd /home/z && zig build-exe hello.zig && ./hello.wasm 2>&1'),
    {
      sample: processTree(bash),
      quietMs: 60_000,
      maxMs: 330_000,
      label: 'zig build-exe',
      where: async () =>
        `in flight: ${JSON.stringify(await page.evaluate(() => window.inFlight?.() ?? []))}`,
    }
  );
  assert.deepEqual(await built, ok('hello from zig\n'));
});
