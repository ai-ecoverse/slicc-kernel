import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const ROUNDS = 10;

const writer = (dir, who) =>
  `{ echo ".timeout 20000"; for i in $(seq 1 200); do echo "insert into tide values ('${who}', $i);"; done; } | sqlite3 ${dir}/one.db 2> /tmp/${who}.err; echo "rc $?"; cat /tmp/${who}.err`;

const failed = (stderr) => stderr.split('\n').filter((line) => /error/i.test(line));

test('in one kernel on the OPFS root, root and a user each insert 200 rows into one sqlite3 database at once: no insert fails to open the database, and every committed row is there, ten times over (#950, bios kernel#665)', {
  timeout: 900_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce' });
  for (const name of ['wasm-coreutils', 'wasm-sqlite3']) await installPackage(page, name);
  await page.evaluate(() => window.kernel.users.add({ name: 'cone' }));
  const as = (script, user) =>
    page.evaluate(
      ([s, u]) => window.kernel.run(['bash', '-c', s], { cwd: '/', ...(u ? { user: u } : {}) }),
      [script, user]
    );
  const rounds = [];
  const errors = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const dir = `/var/tmp/tides${round}`;
    const made = await bash(
      `mkdir -p ${dir} && chmod 777 ${dir} && sqlite3 ${dir}/one.db 'create table tide(who, n);' && chmod 666 ${dir}/one.db`,
      { cwd: '/' }
    );
    assert.equal(made.status, 0, made.stderr);
    const runs = await Promise.all([as(writer(dir, 'root')), as(writer(dir, 'cone'), 'cone')]);
    const count = (who) =>
      `$(sqlite3 ${dir}/one.db "select count(*) from tide where who = '${who}'")`;
    const stored = (await bash(`echo ${count('root')} ${count('cone')}`, { cwd: '/' })).stdout
      .trim()
      .split(' ')
      .map(Number);
    const lost = runs.map((r) => failed(r.stdout));
    errors.push(...lost.flat());
    rounds.push(
      `root ${stored[0]}/${200 - lost[0].length}, cone ${stored[1]}/${200 - lost[1].length}`
    );
    assert.deepEqual(
      stored,
      lost.map((l) => 200 - l.length),
      `round ${round}: every committed row is stored\n${runs.map((r) => r.stdout).join('\n')}`
    );
  }
  console.log(`stored/committed per round: ${rounds.join('; ')}`);
  assert.deepEqual(
    errors.filter((line) => /unable to open database file/.test(line)),
    []
  );
});
