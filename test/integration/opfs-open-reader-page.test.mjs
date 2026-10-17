import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const N = 15;

const py = (lines) =>
  `python3 -c "$(echo ${Buffer.from(lines.join('\n')).toString('base64')} | base64 -d)"`;

const PY_READER = (dir, n) =>
  py([
    'import os, time',
    `d = '${dir}'`,
    "f = open(d + '/f', 'rb')",
    'late = []',
    `for i in range(1, ${n + 1}):`,
    '    f.seek(0)',
    '    f.read()',
    "    open(d + '/r%d' % i, 'w').close()",
    "    while not os.path.exists(d + '/m%d' % i):",
    '        time.sleep(0.002)',
    '    f.seek(0)',
    '    got = f.read().decode()',
    "    if got != 'v%d' % i:",
    "        late.append('%d:%s' % (i, got))",
    "print(' '.join(late) or 'none', flush=True)",
  ]);

async function pair(page, reader) {
  return page.evaluate(
    async (n, argv) => {
      await window.secondKernel({});
      return Promise.all([
        window.second.run(argv, { cwd: '/' }),
        window.kernel.run(['jstest', 'rewrites', '/home/o', String(n)], { cwd: '/' }),
      ]);
    },
    N,
    reader
  );
}

test('a descriptor open in one kernel reads what another kernel on the root rewrote, without reopening (#962)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash('rm -rf /home/o && mkdir /home/o && printf v0 > /home/o/f', { cwd: '/' }),
    ok()
  );
  const [read, write] = await pair(page, ['jstest', 'heldread', '/home/o', String(N)]);
  assert.deepEqual(write, ok());
  assert.deepEqual(read, ok('none\n'));
});

test("a WASIX program's open file reads what another kernel on the root rewrote, without reopening (#962)", {
  timeout: 300_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  assert.deepEqual(
    await bash('rm -rf /home/o && mkdir /home/o && printf v0 > /home/o/f', { cwd: '/' }),
    ok()
  );
  const [read, write] = await pair(page, ['bash', '-c', PY_READER('/home/o', N)]);
  assert.deepEqual(write, ok());
  assert.deepEqual(read, ok('none\n'));
});
