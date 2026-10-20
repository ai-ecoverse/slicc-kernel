import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const MAIN = [
  'export default async function main(ctx) {',
  "  const file = await ctx.open('/home/h/d/b');",
  "  await ctx.fs.writeFile('/home/h/opened', '');",
  "  while (!(await ctx.fs.exists('/home/h/go'))) await new Promise((r) => setTimeout(r, 10));",
  '  const bytes = await file.read(0, 16);',
  '  await ctx.write(1, `read [${new TextDecoder().decode(bytes).trim()}]\\n`);',
  '  return 0;',
  '}',
].join('\n');

const SCRIPT = [
  'rm -rf /home/h && mkdir -p /home/h/d && echo v1 > /home/h/d/b',
  'heldread &',
  'while [ ! -e /home/h/opened ]; do :; done',
  'rm -r /home/h/d 2> /dev/null; echo "rm $?"',
  ': > /home/h/go',
  'wait',
].join('\n');

for (const [fail, want] of [
  [2, 'rm 1\nread [v1]\n'],
  [1, 'rm 0\nread [v1]\n'],
]) {
  test(`a held file whose move aside OPFS refuses ${fail === 2 ? 'twice is never removed: the removal is EBUSY' : 'once is kept on the retry, and the removal works'} (#1218)`, async (t) => {
    const { page, bash } = await booted(chrome, t, {
      worker: `/faulty-move-worker.js?fail=${fail}`,
    });
    await page.evaluate(async (m) => {
      const pkg = {
        name: 'heldread',
        slicc: { commands: { heldread: { abi: 'js', module: 'main.mjs' } } },
      };
      await window.opfs.write('node_modules/heldread/package.json', JSON.stringify(pkg));
      await window.opfs.write('node_modules/heldread/main.mjs', m);
    }, MAIN);
    assert.deepEqual(await bash(SCRIPT, { cwd: '/' }), { status: 0, stdout: want, stderr: '' });
  });
}
