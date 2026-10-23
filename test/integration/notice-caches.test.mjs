import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const py = (lines) =>
  `python3 -c "$(echo ${Buffer.from(['import fcntl, os', ...lines].join('\n')).toString('base64')} | base64 -d)"`;

const clock = (page, change) =>
  page.evaluate(async (c) => {
    const control = new BroadcastChannel('notice-caches-clock');
    const id = Math.random();
    const done = new Promise((resolve) => {
      control.onmessage = ({ data }) => data.done === id && resolve();
    });
    control.postMessage({ ...c, id });
    await done;
    control.close();
  }, change);

const freeze = (page) => clock(page, { freeze: true });
const advance = (page, ms) => clock(page, { advance: ms });

async function pair(page) {
  await page.evaluate(async () => {
    await window.secondKernel({ worker: new URL('/notice/frozen-worker.js', location.href) }, 'a');
    await window.secondKernel({ worker: new URL('/notice/deaf-worker.js', location.href) }, 'b');
  });
  const sh = (name) => (script) =>
    page.evaluate((n, s) => window[n].run(['bash', '-c', s], { cwd: '/' }), name, script);
  assert.deepEqual(await sh('a')('cat /proc/sys/kernel/slicc_shared_root'), ok('1\n'));
  return { mine: sh('a'), other: sh('b') };
}

test("a name another kernel creates while its notice is lost stays missing to a lookup for at most 256 of this kernel's lookups and 100 ms of its clock (#984, #1425)", async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(await bash('rm -rf /tmp/nl && mkdir /tmp/nl', { cwd: '/' }), ok());
  const { mine, other } = await pair(page);
  await freeze(page);
  assert.deepEqual(await mine('[ -e /tmp/nl/f ] || echo missing'), ok('missing\n'));
  assert.deepEqual(await other('echo made > /tmp/nl/f'), ok());
  assert.deepEqual(await mine('[ -e /tmp/nl/f ] || echo missing'), ok('missing\n'));
  await advance(page, 50);
  assert.deepEqual(await mine('[ -e /tmp/nl/f ] || echo missing'), ok('missing\n'));
  assert.deepEqual(
    await mine('for i in $(seq 300); do [ -e /tmp/nl/x ]; done; cat /tmp/nl/f'),
    ok('made\n')
  );
  assert.deepEqual(await mine('[ -e /tmp/nl/g ] || echo missing'), ok('missing\n'));
  assert.deepEqual(await other('echo late > /tmp/nl/g'), ok());
  await advance(page, 101);
  assert.deepEqual(await mine('cat /tmp/nl/g'), ok('late\n'));
});

test('a name another kernel created is found by O_EXCL, mkdir, symlink, link and rename-over even while a lookup still has it as missing (#984, #942)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash('rm -rf /tmp/nx && mkdir /tmp/nx && echo moved > /tmp/nx/g', { cwd: '/' }),
    ok()
  );
  const { mine, other } = await pair(page);
  await freeze(page);
  const names = ['e', 'd', 's', 'h', 'r'];
  const primed = names.map((n) => `[ -e /tmp/nx/${n} ] || echo ${n}`).join('; ');
  assert.deepEqual(await mine(primed), ok('e\nd\ns\nh\nr\n'));
  assert.deepEqual(await other(names.map((n) => `echo theirs > /tmp/nx/${n}`).join(' && ')), ok());
  assert.deepEqual(await mine(primed), ok('e\nd\ns\nh\nr\n'));
  const tries = [
    'set -C; { echo mine > /tmp/nx/e; } 2>/dev/null && echo excl-made || echo excl-refused',
    'case "$(mkdir /tmp/nx/d 2>&1)" in *exists*) echo mkdir-refused ;; *) echo mkdir-made ;; esac',
    'case "$(ln -s g /tmp/nx/s 2>&1)" in *exists*) echo symlink-refused ;; *) echo symlink-made ;; esac',
    'case "$(ln /tmp/nx/g /tmp/nx/h 2>&1)" in *exists*) echo link-refused ;; *) echo link-other ;; esac',
    'mv /tmp/nx/g /tmp/nx/r && cat /tmp/nx/r && ls /tmp/nx',
  ];
  assert.deepEqual(
    await mine(tries.join('; ')),
    ok('excl-refused\nmkdir-refused\nsymlink-refused\nlink-refused\nmoved\nd\ne\nh\nr\ns\n')
  );
});

test("a lock granted after another kernel's write sees the new size even while that kernel's notice is lost (#984, #949)", async (t) => {
  const { page, bash } = await booted(chrome, t);
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  assert.deepEqual(
    await bash('rm -rf /tmp/nk && mkdir /tmp/nk && echo 1 > /tmp/nk/c', { cwd: '/' }),
    ok()
  );
  const { mine, other } = await pair(page);
  await freeze(page);
  assert.deepEqual(await mine('stat -c %s /tmp/nk/c'), ok('2\n'));
  assert.deepEqual(
    await other(
      py([
        "f = open('/tmp/nk/c', 'r+')",
        'fcntl.lockf(f, fcntl.LOCK_EX)',
        "f.write('12345\\n')",
        'f.close()',
      ])
    ),
    ok()
  );
  assert.deepEqual(
    await mine(
      py([
        "f = open('/tmp/nk/c', 'r+')",
        'fcntl.lockf(f, fcntl.LOCK_EX)',
        "print(os.stat('/tmp/nk/c').st_size, f.read().strip())",
      ])
    ),
    ok('6 12345\n')
  );
});

test('a file another kernel saves by writing a temporary and renaming it over shows the new contents and size at once (#984)', async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.deepEqual(
    await bash('rm -rf /tmp/ns && mkdir /tmp/ns && echo old > /tmp/ns/f', { cwd: '/' }),
    ok()
  );
  await page.evaluate(() => window.secondKernel({}));
  const other = (script) =>
    page.evaluate((s) => window.second.run(['bash', '-c', s], { cwd: '/' }), script);
  let text = 'old';
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(
      await bash('stat -c %s /tmp/ns/f; cat /tmp/ns/f', { cwd: '/' }),
      ok(`${text.length + 1}\n${text}\n`)
    );
    text = `saved${'x'.repeat(i)}`;
    assert.deepEqual(
      await other(`echo ${text} > /tmp/ns/.f.tmp && mv /tmp/ns/.f.tmp /tmp/ns/f`),
      ok()
    );
  }
  assert.deepEqual(
    await bash('cat /tmp/ns/f; ls -a /tmp/ns', { cwd: '/' }),
    ok(`${text}\n.\n..\nf\n`)
  );
});
