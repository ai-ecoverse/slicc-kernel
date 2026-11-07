import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { fakeCronClock } from '../../dist/testing.js';

const SPOOL = '/var/spool/cron/crontabs';
const text = (bytes) => new TextDecoder().decode(bytes);
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

async function boot(t, { clock, fresh = true, ...options }) {
  const kernel = await createNodeKernel({ users: 'enforce', ...options, cron: { clock } });
  t.after(() => kernel.terminate());
  if (fresh) {
    await install(kernel, 'wasm-bash');
    await install(kernel, 'wasm-coreutils');
    await kernel.users.add({ name: 'cone' });
  }
  const read = (path) => kernel.readFile(path).then(text, () => undefined);
  const settle = async () => {
    await delay(150);
    await clock.flush();
  };
  const until = async (check, what) => {
    for (let i = 0; i < 400; i++) {
      const value = await check();
      if (value != null && value !== false && !(Array.isArray(value) && value.length === 0))
        return value;
      await delay(50);
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  const minutes = async (n) => {
    for (let i = 0; i < n; i++) {
      clock.advance(60_000);
      await settle();
    }
  };
  const as = (user, script, opts = {}) =>
    kernel.run(['bash', '-c', script], { user, cwd: `/home/${user}`, ...opts });
  return { kernel, read, settle, until, minutes, as };
}

const runs = (log) => (log ?? '').split('\n').filter((line) => line.startsWith('--- '));

test('a job runs at the wall time that date shows in its environment, in the system time zone', async (t) => {
  const installed = Date.UTC(2026, 10, 6, 17, 20, 42);
  const clock = fakeCronClock(installed, 'Europe/Berlin');
  const { read, settle, until, minutes, as } = await boot(t, { clock });
  const seconds = Math.floor(installed / 1000);
  const shown = await as('cone', `echo "$TZ"; date -d @${seconds} '+%H %M %Z'`);
  assert.equal(shown.stdout, 'Europe/Berlin\n18 20 CET\n');
  const [hour, minute] = shown.stdout.split('\n')[1].split(' ').map(Number);
  const table = `# name: selftest\n${minute + 2} ${hour} * * * date -d "$SLICC_CRON_DUE" "+%H:%M %Z $TZ" >> ran\n`;
  assert.equal((await as('cone', 'crontab -', { stdin: table })).status, 0);
  await settle();
  await minutes(1);
  await delay(300);
  assert.equal(await read('/home/cone/ran'), undefined);
  await minutes(1);
  assert.equal(await until(() => read('/home/cone/ran'), 'the job'), '18:22 CET Europe/Berlin\n');
  assert.match(
    await until(() => read('/var/log/cron/cone/selftest.log'), 'the log'),
    /^--- 2026-11-06T17:22:00\.000Z exit=0 missed=0 ---\n/
  );
});

test('the time zone is the browser one unless the embedder names another, and a bad name is refused', async (t) => {
  const host = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const own = await boot(t, { clock: fakeCronClock(Date.UTC(2026, 0, 1), false) });
  assert.equal((await own.as('cone', 'echo "$TZ"')).stdout, `${host}\n`);
  const named = await boot(t, {
    clock: fakeCronClock(Date.UTC(2026, 0, 1)),
    timeZone: 'asia/tokyo',
  });
  assert.equal(
    (await named.as('cone', 'echo "$TZ"; date -d @0 "+%H %Z"')).stdout,
    'Asia/Tokyo\n09 JST\n'
  );
  await assert.rejects(
    createNodeKernel({ timeZone: 'Mars/Olympus_Mons' }),
    /not a time zone: Mars\/Olympus_Mons/
  );
});

test('a schedule replaced under the same name counts from its install, not from the old line (item 5)', async (t) => {
  const clock = fakeCronClock(Date.UTC(2026, 10, 6, 17, 20, 42), 'UTC');
  const { kernel, read, settle, until, minutes, as } = await boot(t, { clock });
  const log = '/var/log/cron/cone/selftest.log';
  const job = (when) => `# name: selftest\n${when} echo "missed $SLICC_CRON_MISSED"\n`;
  assert.equal((await as('cone', 'crontab -', { stdin: job('22 18 * * *') })).status, 0);
  await settle();
  clock.advance(160_000);
  await settle();
  assert.equal((await as('cone', 'crontab -', { stdin: job('* * * * *') })).status, 0);
  await settle();
  await delay(300);
  assert.equal(await read(log), undefined);
  await minutes(1);
  const lines = await until(async () => {
    const found = runs(await read(log));
    return found.length > 0 ? found : undefined;
  }, 'the first run of the new schedule');
  assert.deepEqual(lines, ['--- 2026-11-06T17:24:00.000Z exit=0 missed=0 ---']);
  assert.match(await read(log), /missed 0\n$/);
  kernel.terminate();
  const later = fakeCronClock(Date.UTC(2026, 10, 6, 17, 30, 10), 'UTC');
  const again = await boot(t, { clock: later, root: kernel.root, fresh: false });
  await again.until(async () => runs(await again.read(log)).length === 2, 'the catch-up');
  assert.match(
    await again.read(log),
    /--- 2026-11-06T17:30:00\.000Z exit=0 missed=5 ---\nmissed 5\n$/
  );
});

test('CRON_TZ sets the zone of the schedules after it, as in cronie, and an unknown one is refused', async (t) => {
  const clock = fakeCronClock(Date.UTC(2026, 0, 5, 16, 58, 30), 'Europe/Berlin');
  const { read, settle, until, minutes, as } = await boot(t, { clock });
  const table =
    'CRON_TZ=America/New_York\n# name: noon\n0 12 * * * echo "$TZ $CRON_TZ $SLICC_CRON_DUE" >> ran\n';
  assert.equal((await as('cone', 'crontab -', { stdin: table })).status, 0);
  await settle();
  await minutes(2);
  assert.equal(
    await until(() => read('/home/cone/ran'), 'the noon job'),
    'Europe/Berlin America/New_York 2026-01-05T17:00:00.000Z\n'
  );
  const bad = await as('cone', 'crontab -', { stdin: 'CRON_TZ=Nowhere/Land\n* * * * * true\n' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /"-":2: CRON_TZ: unknown time zone "Nowhere\/Land"/);
});

test('across daylight saving changes a fixed-time job runs once, and one in the skipped hour right after it', async (t) => {
  const clock = fakeCronClock(Date.UTC(2026, 2, 29, 0, 58, 30), 'Europe/Berlin');
  const { read, settle, until, minutes, as } = await boot(t, { clock });
  const table = '# name: fixed\n30 2 * * * echo fixed\n# name: half\n*/30 * * * * echo half\n';
  assert.equal((await as('cone', 'crontab -', { stdin: table })).status, 0);
  await settle();
  await minutes(2);
  const fixed = '/var/log/cron/cone/fixed.log';
  const spring = await until(async () => runs(await read(fixed))[0], 'the spring run');
  assert.equal(spring, '--- 2026-03-29T01:00:00.000Z exit=0 missed=0 ---');
  clock.set(Date.UTC(2026, 9, 24, 23, 59, 30));
  await settle();
  for (let i = 0; i < 6; i++) {
    clock.advance(30 * 60_000);
    await settle();
  }
  const half = '/var/log/cron/cone/half.log';
  const autumn = await until(async () => {
    const all = runs(await read(half)).filter((line) => line.includes('2026-10-25'));
    return all.length === 6 && all;
  }, 'the half-hourly runs');
  assert.deepEqual(autumn.map((line) => line.slice(4, 28)).sort(), [
    '2026-10-25T00:00:00.000Z',
    '2026-10-25T00:30:00.000Z',
    '2026-10-25T01:00:00.000Z',
    '2026-10-25T01:30:00.000Z',
    '2026-10-25T02:00:00.000Z',
    '2026-10-25T02:30:00.000Z',
  ]);
  const days = await until(async () => {
    const all = runs(await read(fixed))
      .map((line) => line.slice(4, 28))
      .filter((due) => /^2026-(03-29|10-25)/.test(due));
    return all.length >= 2 && all;
  }, 'both fixed runs');
  await delay(300);
  assert.deepEqual(
    runs(await read(fixed))
      .map((line) => line.slice(4, 28))
      .filter((due) => /^2026-(03-29|10-25)/.test(due)),
    days
  );
  assert.deepEqual(days, ['2026-03-29T01:00:00.000Z', '2026-10-25T00:30:00.000Z']);
});

test('a yearly job in the repeated hour, installed months before, runs at its first occurrence', async (t) => {
  const clock = fakeCronClock(Date.UTC(2026, 0, 1, 0, 0, 30), 'Europe/Berlin');
  const { read, settle, until, as } = await boot(t, { clock });
  const table = '# name: yearly\n30 2 25 10 * echo yearly\n';
  assert.equal((await as('cone', 'crontab -', { stdin: table })).status, 0);
  await settle();
  clock.set(Date.UTC(2026, 9, 25, 0, 29, 30));
  await settle();
  clock.advance(60_000);
  await settle();
  const log = '/var/log/cron/cone/yearly.log';
  const first = await until(async () => runs(await read(log))[0], 'the run');
  assert.equal(first, '--- 2026-10-25T00:30:00.000Z exit=0 missed=0 ---');
});
