import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const MAIN = [
  'export default async function main(ctx) {',
  "  const file = await ctx.open('/home/fl/f', { read: true, write: true });",
  "  await file.write(0, new TextEncoder().encode('newer'));",
  "  await ctx.fs.writeFile('/home/fl/opened', '');",
  "  while (!(await ctx.fs.exists('/home/fl/go'))) await new Promise((r) => setTimeout(r, 10));",
  '  const tries = [',
  "    ['link', () => ctx.fs.link('/home/fl/f', '/home/fl/g')],",
  "    ['copy', () => ctx.fs.copyFile('/home/fl/f', '/home/fl/h')],",
  '  ];',
  '  for (const [name, call] of tries) {',
  '    try {',
  '      await call();',
  '      await ctx.write(1, `${name} ok\\n`);',
  '    } catch (err) {',
  '      await ctx.write(1, `${name} ${err.code}\\n`);',
  '    }',
  '  }',
  '  return 0;',
  '}',
].join('\n');

test('a link or copy by name of a file this program holds with unwritten data, removed from OPFS behind the kernel, fails with ENOENT as for any missing name, not EIO (#1423, #1477)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  await page.evaluate(async (m) => {
    const pkg = {
      name: 'flush',
      slicc: { commands: { flush: { abi: 'js', module: 'main.mjs' } } },
    };
    await window.opfs.write('node_modules/flush/package.json', JSON.stringify(pkg));
    await window.opfs.write('node_modules/flush/main.mjs', m);
  }, MAIN);
  await bash('rm -rf /home/fl && mkdir -p /home/fl && printf old-bytes > /home/fl/f', { cwd: '/' });
  await page.evaluate(() => {
    window.flushing = window.kernel.run(['flush'], { cwd: '/' });
  });
  while (!(await page.evaluate(() => window.opfs.exists('home/fl/opened'))))
    await new Promise((resolve) => setTimeout(resolve, 10));
  await page.evaluate(async () => {
    const top = await navigator.storage.getDirectory();
    const dir = await (await top.getDirectoryHandle('home')).getDirectoryHandle('fl');
    await dir.removeEntry('f');
    await window.opfs.write('home/fl/go', '');
  });
  const r = await page.evaluate(() => window.flushing);
  assert.deepEqual(
    { status: r.status, stdout: r.stdout, stderr: r.stderr },
    { status: 0, stdout: 'link ENOENT\ncopy ENOENT\n', stderr: '' }
  );
});
