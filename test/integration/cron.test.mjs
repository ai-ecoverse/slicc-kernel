import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { fakeCronClock } from '../../dist/testing.js';

const SPOOL = '/var/spool/cron/crontabs';
const START = Date.UTC(2026, 0, 1, 10, 0, 30);
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

async function boot(t, options = {}) {
  const clock = options.clock ?? fakeCronClock(START);
  const kernel = await createNodeKernel({ users: 'enforce', ...options, cron: { clock } });
  t.after(() => kernel.terminate());
  if (options.install !== false) {
    await install(kernel, 'wasm-bash');
    await install(kernel, 'wasm-coreutils');
  }
  const read = (path) => kernel.readFile(path).then(text, () => undefined);
  const settle = async () => {
    await delay(150);
    await clock.flush();
  };
  const until = async (check, what) => {
    for (let i = 0; i < 400; i++) {
      const value = await check();
      if (value) return value;
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
  const sleeping = async () =>
    Number(
      (
        await kernel.run(
          [
            'bash',
            '-c',
            'n=0; for d in /proc/[0-9]*; do read -r -d "" a < $d/cmdline 2>/dev/null; [ "$a" = sleep ] && n=$((n+1)); done; echo $n',
          ],
          { cwd: '/' }
        )
      ).stdout
    );
  return { kernel, clock, read, settle, until, minutes, sleeping };
}

test('a user crontab job runs on time as its user, in its home, with only a login environment', async (t) => {
  const { kernel, read, settle, until, minutes } = await boot(t, { env: { HOST_SECRET: 'leak' } });
  await kernel.users.add({ name: 'cone' });
  await kernel.writeFile(
    `${SPOOL}/cone`,
    'GREETING=hi\n* * * * * echo "$(id -u) $(pwd) $HOME $USER $LOGNAME $SHELL $GREETING $SLICC_CRON $SLICC_CRON_DUE $SLICC_CRON_MISSED ${HOST_SECRET-none}" >> ran\n'
  );
  await settle();
  assert.equal(await read('/home/cone/ran'), undefined);
  await minutes(1);
  const ran = await until(() => read('/home/cone/ran'), 'the job');
  assert.equal(
    ran,
    '1000 /home/cone /home/cone cone cone /bin/bash hi 1 2026-01-01T10:01:00.000Z 0 none\n'
  );
  const owner = await kernel.run(['bash', '-c', 'stat -c %U /home/cone/ran'], { cwd: '/' });
  assert.equal(owner.stdout, 'cone\n');
});

const runs = (log) => (log ?? '').split('\n').filter((line) => line.startsWith('--- '));

test('a job that missed several minutes runs once, says how many it missed, and logs each run for its user only', async (t) => {
  const { kernel, clock, read, settle, until, minutes } = await boot(t);
  await kernel.users.add({ name: 'cone' });
  await kernel.users.add({ name: 'scoop' });
  await kernel.writeFile(
    `${SPOOL}/cone`,
    '# name: tick\n* * * * * echo "missed $SLICC_CRON_MISSED"\n'
  );
  await settle();
  clock.advance(10 * 60_000);
  await settle();
  const log = '/var/log/cron/cone/tick.log';
  assert.equal(
    await until(() => read(log), 'the log'),
    '--- 2026-01-01T10:10:00.000Z exit=0 missed=9 ---\nmissed 9\n'
  );
  await minutes(1);
  await until(async () => runs(await read(log)).length === 2, 'the second run');
  assert.match(await read(log), /--- 2026-01-01T10:11:00.000Z exit=0 missed=0 ---\nmissed 0\n$/);
  assert.equal((await kernel.run(['cat', log], { user: 'cone', cwd: '/' })).status, 0);
  assert.notEqual((await kernel.run(['cat', log], { user: 'scoop', cwd: '/' })).status, 0);
});

test('a due run is stamped before it starts, so a kernel killed mid-job never runs it again', async (t) => {
  const first = await boot(t);
  await first.kernel.users.add({ name: 'cone' });
  await first.kernel.writeFile(
    `${SPOOL}/cone`,
    '# name: slow\n* * * * * echo "start $SLICC_CRON_DUE" >&2; sleep 600\n'
  );
  await first.settle();
  await first.minutes(1);
  await first.until(async () => (await first.sleeping()) === 1, 'the job to start');
  first.kernel.terminate();
  const later = fakeCronClock(START + 60_000 + 5_000);
  const second = await boot(t, { root: first.kernel.root, install: false, clock: later });
  await second.kernel.writeFile(
    `${SPOOL}/cone`,
    '# name: slow\n* * * * * echo "start $SLICC_CRON_DUE"\n'
  );
  await second.settle();
  await delay(500);
  assert.equal(await second.read('/var/log/cron/cone/slow.log'), undefined);
  await second.minutes(1);
  assert.equal(
    await second.until(() => second.read('/var/log/cron/cone/slow.log'), 'the next run'),
    '--- 2026-01-01T10:02:00.000Z exit=0 missed=0 ---\nstart 2026-01-01T10:02:00.000Z\n'
  );
});

test('an @reboot job runs once per boot', async (t) => {
  const first = await boot(t);
  await first.kernel.users.add({ name: 'cone' });
  await first.kernel.writeFile(`${SPOOL}/cone`, '# name: up\n@reboot echo booted\n');
  await first.settle();
  await delay(300);
  assert.equal(await first.read('/var/log/cron/cone/up.log'), undefined);
  first.kernel.terminate();
  const second = await boot(t, { root: first.kernel.root, install: false });
  const log = await second.until(() => second.read('/var/log/cron/cone/up.log'), 'the reboot run');
  assert.equal(log, '--- 2026-01-01T10:00:30.000Z exit=0 missed=0 ---\nbooted\n');
  await second.minutes(2);
  await delay(300);
  assert.equal(runs(await second.read('/var/log/cron/cone/up.log')).length, 1);
  second.kernel.terminate();
  const third = await boot(t, { root: first.kernel.root, install: false });
  await third.until(
    async () => runs(await third.read('/var/log/cron/cone/up.log')).length === 2,
    "the second boot's run"
  );
});

test('a changed crontab and /etc/crontab take effect without a restart', async (t) => {
  const { kernel, read, settle, until, minutes } = await boot(t);
  await kernel.users.add({ name: 'cone' });
  await kernel.writeFile(`${SPOOL}/cone`, '* * * * * echo a >> out\n');
  await settle();
  await minutes(1);
  await until(async () => (await read('/home/cone/out')) === 'a\n', 'the first table');
  await kernel.writeFile(`${SPOOL}/cone`, '* * * * * echo b >> out\n');
  await kernel.writeFile('/etc/crontab', '* * * * * cone  echo "sys $USER" >> sys\n');
  await settle();
  await minutes(1);
  await until(async () => (await read('/home/cone/sys')) === 'sys cone\n', 'the system table');
  await until(async () => (await read('/home/cone/out')) === 'a\nb\n', 'the changed table');
});

test('two kernels on one root run each due once, and the second takes over when the first ends', async (t) => {
  const clock = fakeCronClock(START);
  const first = await boot(t, { clock });
  await first.kernel.users.add({ name: 'cone' });
  await first.kernel.writeFile(`${SPOOL}/cone`, '# name: due\n* * * * * echo $SLICC_CRON_DUE\n');
  const second = await boot(t, { clock, root: first.kernel.root, install: false });
  const log = '/var/log/cron/cone/due.log';
  await first.settle();
  await first.minutes(1);
  await first.until(async () => runs(await first.read(log)).length === 1, 'the first run');
  await delay(300);
  assert.equal(runs(await first.read(log)).length, 1);
  first.kernel.terminate();
  await second.settle();
  await second.minutes(1);
  const taken = await second.until(async () => {
    const lines = runs(await second.read(log));
    return lines.length === 2 && lines;
  }, 'the run after the takeover');
  assert.deepEqual(taken, [
    '--- 2026-01-01T10:01:00.000Z exit=0 missed=0 ---',
    '--- 2026-01-01T10:02:00.000Z exit=0 missed=0 ---',
  ]);
});

test('a bad line is reported in cron.err and the next line still runs', async (t) => {
  const { kernel, read, settle, until, minutes } = await boot(t);
  await kernel.users.add({ name: 'cone' });
  await kernel.writeFile(`${SPOOL}/cone`, '61 * * * * echo never\n* * * * * echo fine >> ok\n');
  await kernel.writeFile(`${SPOOL}/ghost`, '* * * * * echo nobody\n');
  await settle();
  await minutes(1);
  await until(async () => (await read('/home/cone/ok')) === 'fine\n', 'the good line');
  const errors = await read('/var/log/cron/cron.err');
  assert.match(errors, /\/var\/spool\/cron\/crontabs\/cone:1: minute: 61 is outside 0-59\n/);
  assert.match(errors, /\/var\/spool\/cron\/crontabs\/ghost: skipped: there is no user ghost\n/);
});

test('a crontab another user could write is not run', async (t) => {
  const { kernel, read, settle, until, minutes } = await boot(t);
  await kernel.users.add({ name: 'cone' });
  await kernel.writeFile(`${SPOOL}/cone`, '* * * * * echo bad >> bad\n', { mode: 0o666 });
  await kernel.chmod(`${SPOOL}/cone`, 0o666);
  await settle();
  await minutes(1);
  const errors = await until(() => read('/var/log/cron/cron.err'), 'the report');
  assert.match(
    errors,
    /crontabs\/cone: skipped: it must be a file of its user or root, writable by its owner only/
  );
  assert.equal(await read('/home/cone/bad'), undefined);
});

test('runs of one job overlap, up to 16 per user, and a run past that is skipped and logged', async (t) => {
  const { kernel, read, settle, until, minutes, sleeping } = await boot(t);
  await kernel.users.add({ name: 'cone' });
  await kernel.writeFile(`${SPOOL}/cone`, '# name: hang\n* * * * * sleep 600\n');
  await settle();
  await minutes(2);
  await until(async () => (await sleeping()) === 2, 'two overlapping runs');
  await minutes(15);
  await until(async () => (await sleeping()) === 16, 'sixteen runs');
  const log = await until(() => read('/var/log/cron/cone/hang.log'), 'the skip');
  assert.equal(log, '--- 2026-01-01T10:17:00.000Z skipped: 16 cron jobs of cone are running ---\n');
  assert.match(
    await read('/var/log/cron/cron.err'),
    /cone\/hang: run due 2026-01-01T10:17:00.000Z skipped: 16 cron jobs of cone are running\n/
  );
});

test('a clock set back by more than two minutes runs nothing until the next due after the new time', async (t) => {
  const { kernel, clock, read, settle, until, minutes } = await boot(t);
  await kernel.users.add({ name: 'cone' });
  await kernel.writeFile(`${SPOOL}/cone`, '# name: back\n* * * * * echo $SLICC_CRON_MISSED\n');
  await settle();
  await minutes(1);
  const log = '/var/log/cron/cone/back.log';
  await until(async () => runs(await read(log)).length === 1, 'the first run');
  clock.set(START - 3_600_000);
  await settle();
  await delay(300);
  assert.equal(runs(await read(log)).length, 1);
  await minutes(1);
  const lines = await until(async () => {
    const all = runs(await read(log));
    return all.length === 2 && all;
  }, 'the run after the jump');
  assert.equal(lines[1], '--- 2026-01-01T09:01:00.000Z exit=0 missed=0 ---');
});

test('a user cannot point their job log at a root file, and the service refuses a log it does not trust', async (t) => {
  const { kernel, read, settle, until, minutes } = await boot(t);
  await kernel.users.add({ name: 'cone' });
  await kernel.writeFile(`${SPOOL}/cone`, '# name: x\n* * * * * echo pwned\n');
  await settle();
  await minutes(1);
  const log = '/var/log/cron/cone/x.log';
  await until(() => read(log), 'the first run');
  const passwd = await read('/etc/passwd');
  const as = (user, script) => kernel.run(['bash', '-c', script], { user, cwd: '/' });
  for (const script of [
    `ln -sf /etc/passwd ${log}`,
    `rm -f ${log}`,
    `mv ${log} /tmp/x`,
    'ln -s /etc/passwd /var/log/cron/cone/y.log',
  ]) {
    assert.notEqual((await as('cone', script)).status, 0, script);
  }
  assert.equal((await as('root', "stat -c '%u %a' /var/log/cron/cone")).stdout, '0 755\n');
  assert.equal((await as('root', `stat -c '%u %a' ${log}`)).stdout, '1000 600\n');
  await as('root', `chown cone /var/log/cron/cone`);
  assert.equal((await as('cone', `ln -sf /etc/passwd ${log}`)).status, 0);
  await minutes(1);
  const errors = await until(() => read('/var/log/cron/cron.err'), 'the refusal');
  assert.match(
    errors,
    /\/var\/log\/cron\/cone\/x\.log not written: \/var\/log\/cron\/cone must be a directory of root\n/
  );
  assert.equal(await read('/etc/passwd'), passwd);
  assert.equal((await as('root', 'stat -c %a /etc/passwd')).stdout, '644\n');
  await as('root', `chown root /var/log/cron/cone`);
  await minutes(1);
  await until(
    async () =>
      /x\.log not written: it must be a file of uid 1000 or root\n$/.test(
        await read('/var/log/cron/cron.err')
      ),
    'the file refusal'
  );
  assert.equal(await read('/etc/passwd'), passwd);
});
