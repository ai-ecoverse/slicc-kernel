import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOWNSTREAM_OK, downstreamLine, downstreamOf } from '../../tools/cert-review/lib.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const at = {
  biosRef: 'c2cec127b935419049568f584093d7ef03ac0721',
  shards: ['sweep', 'guard', 'k4-link'],
};
const row = (test, shard = 'sweep') => ({ shard, test, log: '' });
const result = (o = {}) => ({
  ok: true,
  biosRef: at.biosRef,
  url: 'https://github.com/ai-ecoverse/slicc-kernel/actions/runs/1',
  counts: { pass: 10, skip: 0, fail: 0, regression: 0, both: 0, flaky: 0 },
  regressions: [],
  both: [],
  flaky: [],
  failures: [],
  missingShards: [],
  unexplainedExits: [],
  refused: [],
  ambiguous: [],
  ...o,
});

test('the downstream smoke: a green canary passes, a regression or an unexplained failure fails, and a missing or partial result is INCOMPLETE, never a pass (#480)', () => {
  const pass = downstreamOf(result(), at);
  assert.equal(pass.state, 'PASS');
  assert.match(
    pass.line,
    /^downstream: PASS bios c2cec127b935 sweep,guard,k4-link: 10 pass \(https:\/\/github\.com\/ai-ecoverse\/slicc-kernel\/actions\/runs\/1\)$/
  );
  const regression = downstreamOf(
    result({ counts: { pass: 9, regression: 1 }, regressions: [row('seven boots')] }),
    at
  );
  assert.equal(regression.state, 'FAIL');
  assert.match(
    regression.line,
    /^downstream: FAIL .*1 regressions, 0 failures \(sweep: seven boots\)/
  );
  assert.equal(
    downstreamOf(result({ counts: { pass: 9, fail: 1 }, failures: [row('x')] }), at).state,
    'FAIL'
  );
  for (const partial of [
    undefined,
    'not json',
    { ok: false },
    result({ missingShards: ['guard'] }),
    result({ unexplainedExits: [{ shard: 'k4-link', exit: 137 }] }),
    result({ refused: [{ name: 'kernel-tgz' }] }),
    result({ counts: { pass: 0, skip: 0, fail: 0, regression: 0, both: 0, flaky: 0 } }),
  ]) {
    const found = downstreamOf(partial, at);
    assert.equal(found.state, 'INCOMPLETE', JSON.stringify(partial));
    assert.match(found.line, /^downstream: INCOMPLETE /);
    assert.equal(DOWNSTREAM_OK.has(found.state), false);
  }
});

test('known bios failures pass with a note and a notice, a canary that fails on main alike is not judged and notifies, and an override passes a regression in the line (#480)', () => {
  const known = downstreamOf(
    result({ counts: { pass: 9, both: 1 }, both: [row('pydata loads', 'rest')] }),
    at
  );
  assert.equal(known.state, 'PASS');
  assert.match(known.line, /; known downstream failures 1 \(rest: pydata loads\)/);
  assert.equal(known.notify.length, 1);
  const broken = downstreamOf(
    result({ counts: { pass: 0, both: 3 }, both: [row('a'), row('b'), row('c')] }),
    at
  );
  assert.equal(broken.state, 'NOT_JUDGED');
  assert.match(broken.line, /^downstream: not judged \(bios canary failing on main\) /);
  assert.match(broken.notify[0], /^bios canary is failing on main/);
  assert.equal(DOWNSTREAM_OK.has('NOT_JUDGED'), true);
  const flaky = downstreamOf(result({ counts: { pass: 9, flaky: 1 }, flaky: [row('f')] }), at);
  assert.deepEqual([flaky.state, /; flaky 1/.test(flaky.line)], ['PASS', true]);
  const regressed = result({
    counts: { pass: 9, regression: 1 },
    regressions: [row('seven boots')],
  });
  const overridden = downstreamOf(regressed, { ...at, override: 'PASS' });
  assert.equal(overridden.state, 'OVERRIDDEN');
  assert.match(
    overridden.line,
    /^downstream: overridden \(downstream-override on the head, by the coordinator\) /
  );
  for (const stale of ['FAIL', 'INCOMPLETE', ''])
    assert.equal(
      downstreamOf(regressed, { ...at, override: stale }).state,
      'FAIL',
      `override ${stale}`
    );
  assert.equal(
    downstreamLine([]),
    'downstream: not run (no merge group of this release carried it)'
  );
  assert.equal(
    downstreamLine(['downstream: PASS bios x', 'downstream: PASS bios x']),
    'downstream: PASS bios x'
  );
  assert.equal(
    downstreamLine(['downstream: PASS a', 'downstream: overridden b']),
    'downstream: PASS a | overridden b'
  );
});

test('downstream.mjs ends with its verdict through the gate: PASS for a pass, FAIL and a non-zero exit for a regression or no result (#480)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-downstream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = async (body, extra = []) => {
    const file = join(dir, `r${Math.random()}.json`);
    if (body !== undefined) await writeFile(file, JSON.stringify(body));
    const out = join(dir, 'downstream.json');
    const r = spawnSync(
      'tools/cert-review/gate.sh',
      [
        'downstream',
        process.execPath,
        'tools/cert-review/downstream.mjs',
        '--result',
        file,
        '--shards',
        'sweep',
        '--out',
        out,
        ...extra,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      }
    );
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const pass = await run(result());
  assert.equal(pass.code, 0, pass.out);
  assert.match(pass.out, /^downstream: PASS downstream: PASS /m);
  const fail = await run(
    result({ counts: { pass: 1, regression: 1 }, regressions: [row('seven boots')] })
  );
  assert.equal(fail.code, 1, fail.out);
  assert.match(fail.out, /^downstream: FAIL downstream: FAIL /m);
  const missing = await run(undefined);
  assert.equal(missing.code, 1);
  assert.match(
    missing.out,
    /^downstream: FAIL downstream: INCOMPLETE .*the canary left no readable result/m
  );
  const overridden = await run(
    result({ counts: { pass: 1, regression: 1 }, regressions: [row('x')] }),
    ['--override', 'PASS']
  );
  assert.equal(overridden.code, 0, overridden.out);
  const broken = await run(result({ counts: { pass: 0, both: 2 }, both: [row('a'), row('b')] }));
  assert.equal(broken.code, 0, broken.out);
  assert.match(broken.out, /::warning title=downstream::bios canary is failing on main/);
});
