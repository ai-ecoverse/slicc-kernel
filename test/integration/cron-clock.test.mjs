import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeCronClock } from '../../dist/testing.js';

test('a fake cron clock wakes sleepers as time moves, and flush waits for them to sleep again', async () => {
  const clock = fakeCronClock();
  assert.equal(clock.now(), Date.UTC(2026, 0, 1));
  assert.equal(clock.utc, true);
  const signal = new AbortController().signal;
  const fired = [];
  const loop = async () => {
    for (;;) {
      const due = Math.floor(clock.now() / 60_000) * 60_000 + 60_000;
      await clock.sleep(due, signal);
      await new Promise((resolve) => setTimeout(resolve, 10));
      fired.push(new Date(clock.now()).toISOString());
    }
  };
  void loop();
  await clock.flush();
  assert.deepEqual(fired, []);
  clock.advance(60_000);
  await clock.flush();
  assert.deepEqual(fired, ['2026-01-01T00:01:00.000Z']);
  clock.set(Date.UTC(2026, 0, 1, 0, 5));
  await clock.flush();
  assert.deepEqual(fired, ['2026-01-01T00:01:00.000Z', '2026-01-01T00:05:00.000Z']);
  assert.equal(clock.sleepers, 1);
});

test('an aborted sleep on a fake cron clock ends at once', async () => {
  const clock = fakeCronClock(0, false);
  assert.equal(clock.utc, false);
  const stop = new AbortController();
  const sleeping = clock.sleep(60_000, stop.signal);
  assert.equal(clock.sleepers, 1);
  stop.abort();
  await sleeping;
  assert.equal(clock.sleepers, 0);
  assert.equal(clock.now(), 0);
});
