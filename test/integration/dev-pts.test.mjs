import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name, skip) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    const rel = relative(base, file);
    if (skip?.test(rel)) continue;
    await kernel.writeFile(`/node_modules/@ai-ecoverse/${name}/${rel}`, await readFile(file));
  }
}

const PY =
  "import os; print('py', ' '.join(sorted(os.listdir('/dev/pts'))), 'pts' in os.listdir('/dev'))";
const py = `python3 -c "$(echo ${Buffer.from(PY).toString('base64')} | base64 -d)"`;

const SCRIPT = [
  'echo "empty [$(ls -A /dev/pts)]"',
  'case " $(ls /dev | tr "\\n" " ") " in *" pts "*) echo pts;; esac',
  'exec 3</dev/ptmx; exec 4</dev/ptmx',
  'echo "two [$(ls /dev/pts | tr "\\n" " ")]"',
  py,
  'ln -s /dev/pts/1 /tmp/pty',
  'stat -L -c "%n %f" /tmp/pty /dev/pts/1',
  'exec 4<&-',
  'echo "one [$(ls /dev/pts | tr "\\n" " ")]"',
  'stat -L /tmp/pty > /dev/null 2>&1 || echo "gone"',
].join('\n');

for (const users of ['enforce', 'off']) {
  test(`an Emscripten and a WASIX program list /dev/pts with the open ptys, and stat one through a symlink (#1040, users: ${users})`, {
    timeout: 180_000,
  }, async (t) => {
    const kernel = await createNodeKernel({ users });
    t.after(() => kernel.terminate());
    for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
    await install(kernel, 'wasix-python', /^lib\/libpython[^/]*\.a$/);
    const r = await kernel.run(['bash', '-c', `rm -f /tmp/pty\n${SCRIPT}`], { cwd: '/' });
    assert.equal(r.stderr, '');
    assert.equal(
      r.stdout,
      [
        'empty []',
        'pts',
        'two [0 1 ]',
        'py 0 1 True',
        '/tmp/pty 2190',
        '/dev/pts/1 2190',
        'one [0 ]',
        'gone',
        '',
      ].join('\n')
    );
  });
}

test('an Emscripten stat through a symlink to /dev/pts/256 answers the pty, whose device number overflows the minor byte (#1069)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  const r = await kernel.run(
    [
      'bash',
      '-c',
      'rm -f /tmp/pty; for i in $(seq 0 256); do exec {f}</dev/ptmx; done; ln -s /dev/pts/256 /tmp/pty; stat -L -c "%n %a %u %g" /tmp/pty /dev/pts/256',
    ],
    { cwd: '/' }
  );
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, '/tmp/pty 620 0 0\n/dev/pts/256 620 0 0\n');
});

for (const users of ['enforce', 'off']) {
  test(`an Emscripten program lists /dev/ptmx in /dev and stats it as Linux's 5,2 character device, root's under users (#1068, users: ${users})`, {
    timeout: 120_000,
  }, async (t) => {
    const kernel = await createNodeKernel({ users });
    t.after(() => kernel.terminate());
    for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
    const r = await kernel.run(
      [
        'bash',
        '-c',
        'case " $(ls /dev | tr "\\n" " ") " in *" ptmx "*) echo listed;; esac; stat -c "%n %f %t,%T" /dev/ptmx; exec 3</dev/ptmx && echo opened',
      ],
      { cwd: '/' }
    );
    assert.equal(r.stderr, '');
    assert.equal(r.stdout, 'listed\n/dev/ptmx 21b6 5,2\nopened\n');
    const alias = await kernel.run(
      [
        'bash',
        '-c',
        'rm -f /tmp/pm; ls /dev > /dev/null; cd /dev; exec 3<ptmx && echo relative; ln -s /dev/ptmx /tmp/pm; exec 4</tmp/pm && echo linked; ls /dev/pts | tr "\\n" " "',
      ],
      { cwd: '/' }
    );
    assert.equal(alias.stderr, '');
    assert.equal(alias.stdout, 'relative\nlinked\n0 1 ');
    if (users === 'enforce') {
      const own = await kernel.run(['stat', '-c', '%u %g', '/dev/ptmx'], { cwd: '/' });
      assert.equal(own.stdout, '0 0\n');
    }
  });
}
