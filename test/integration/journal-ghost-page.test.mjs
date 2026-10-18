import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const ROUNDS = 8;

const WRITERS = [
  'import os, sqlite3, subprocess, sys',
  'D = "/root/jg/g.db"',
  'if len(sys.argv) > 1:',
  '    c = sqlite3.connect(D, timeout=30, isolation_level=None)',
  '    for i in range(25):',
  '        try: c.execute("insert into t values(?)", (int(sys.argv[1]) * 100 + i,))',
  '        except Exception as e: print(f"row {i}: {e}", file=sys.stderr); sys.exit(1)',
  '    sys.exit(0)',
  'for f in (D, D + "-journal"):',
  '    if os.path.exists(f): os.remove(f)',
  'c = sqlite3.connect(D, isolation_level=None); c.execute("create table t(v)")',
  'ws = [subprocess.Popen([sys.executable, __file__, str(k)]) for k in (1, 2, 3)]',
  'codes = [w.wait() for w in ws]',
  'print(codes, c.execute("select count(*) from t").fetchone()[0])',
  'j = D + "-journal"',
  'seen = os.path.exists(j)',
  'try:',
  '    os.close(os.open(j, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)); made = True; os.remove(j)',
  'except FileExistsError:',
  '    made = False',
  'print("journal", "agrees" if seen != made else f"ghost exists={seen} created={made}")',
].join('\n');

test('three sqlite writers on the OPFS root never leave a -journal name that stat calls missing and an exclusive create calls taken (#1086, #950)', {
  timeout: 900_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  await installPackage(page, 'wasm-coreutils');
  await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
  await bash('mkdir -p /root/jg', { cwd: '/' });
  await page.evaluate((text) => window.opfs.write('root/jg/sw.py', text), WRITERS);
  const seen = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const r = await bash('python3 /root/jg/sw.py', { cwd: '/' });
    seen.push(`${round}: ${r.stdout.trim().replaceAll('\n', ' / ')} ${r.stderr.trim()}`);
    assert.equal(r.status, 0, seen.join('\n'));
    assert.match(r.stdout, /^\[0, 0, 0\] 75\njournal agrees\n$/, seen.join('\n'));
  }
});
