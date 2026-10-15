import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  decide,
  deltaFiles,
  diffSuites,
  knownLine,
  mergedPrs,
  parseResults,
  provenanceProblems,
  resultsMap,
  rowOf,
  testCommand,
  titlesFromPatch,
} from '../../tools/cert-review/lib.mjs';

const fixtures = new URL('fixtures/cert-review/', import.meta.url);
const tools = new URL('../../tools/cert-review/', import.meta.url);
const delta = JSON.parse(await readFile(new URL('delta.json', fixtures), 'utf8'));
const rows = delta.prs.map(({ pr, files }) => rowOf(pr, files));
const res = (file, name, status) => ({ file, name, status });

test('the delta parser takes merged pull requests once, in order, and reads the integration test titles each one adds or changes', () => {
  assert.deepEqual(mergedPrs(delta.commits), [7, 12]);
  const [fix, feat, ci] = rows;
  assert.deepEqual(
    { kind: fix.kind, behaviour: fix.behaviour, breaking: fix.breaking, src: fix.src },
    { kind: 'fix', behaviour: true, breaking: false, src: true }
  );
  assert.deepEqual(fix.tests, [
    {
      file: 'test/integration/node.test.mjs',
      status: 'modified',
      titles: [
        'an existing test whose body changed, with a title too long for the hunk header that git cuts sho\u2026',
        'a new test',
        'a new subtest with "quotes"',
        'a template \u2026',
      ],
    },
  ]);
  assert.deepEqual(
    {
      kind: feat.kind,
      breaking: feat.breaking,
      behaviour: feat.behaviour,
      titles: feat.tests[0].titles,
    },
    { kind: 'feat', breaking: true, behaviour: true, titles: ['udp echo'] }
  );
  assert.deepEqual(
    { kind: ci.kind, behaviour: ci.behaviour, tests: ci.tests },
    { kind: 'ci', behaviour: false, tests: [] }
  );
  assert.deepEqual(deltaFiles(rows), [
    'test/integration/node.test.mjs',
    'test/integration/udp.test.mjs',
  ]);
  assert.deepEqual(titlesFromPatch(undefined), []);
});

test("the NEGATIVE decision table: a fix's test must fail on the previous dist and pass on the release", () => {
  const file = 'test/integration/n.test.mjs';
  const row = (kind, titles = ['t']) => ({
    pr: 1,
    title: `${kind}: x`,
    kind,
    behaviour: ['fix', 'feat', 'perf', 'revert'].includes(kind),
    tests: titles === null ? [] : [{ file, status: 'modified', titles }],
  });
  const runs = (prev, next) => [
    resultsMap(prev.map((s) => res(file, 't', s))),
    resultsMap(next.map((s) => res(file, 't', s))),
  ];
  const decision = (r, prev, next) => decide(r, ...runs(prev, next)).decision;
  assert.equal(decision(row('fix'), ['fail'], ['pass']), 'negative');
  assert.equal(decision(row('fix'), ['pass'], ['pass']), 'no-negative');
  assert.equal(decision(row('fix'), [], ['pass']), 'prev-not-run');
  assert.equal(decision(row('fix'), ['fail'], ['fail']), 'fails-on-release');
  assert.equal(decision(row('fix'), ['fail'], ['skip']), 'not-run');
  assert.equal(decision(row('fix'), ['fail'], []), 'not-run');
  assert.equal(decision(row('feat'), ['pass'], ['pass']), 'passes');
  assert.equal(decision(row('feat'), ['fail'], ['cancelled']), 'fails-on-release');
  assert.equal(decision(row('fix', null), [], []), 'no-test');
  assert.equal(decision(row('fix', []), [], []), 'no-titles');
  assert.equal(decision(row('ci', null), [], []), 'not-behaviour');
  const nested = decide(
    row('fix', ['parent \u2026']),
    resultsMap([res(file, 'parent one > child', 'fail'), res(file, 'other', 'pass')]),
    resultsMap([res(file, 'parent one > child', 'pass'), res(file, 'parent one', 'pass')])
  );
  assert.deepEqual(nested.checks, [{ file, title: 'parent \u2026', next: 'pass', prev: 'fail' }]);
  assert.equal(nested.decision, 'negative');
});

test('the suite diff compares two runs test by test and keeps a test failing if any of its runs failed', () => {
  const f = 'test/integration/a.test.mjs';
  const base = resultsMap([
    res(f, 'stays', 'pass'),
    res(f, 'breaks', 'pass'),
    res(f, 'heals', 'fail'),
    res(f, 'still', 'fail'),
    res(f, 'gone', 'pass'),
  ]);
  const next = resultsMap([
    res(f, 'stays', 'pass'),
    { ...res(f, 'breaks', 'fail'), error: 'boom' },
    res(f, 'heals', 'pass'),
    res(f, 'still', 'cancelled'),
    res(f, 'new ok', 'pass'),
    res(f, 'new bad', 'fail'),
    res(f, 'twice', 'pass'),
    res(f, 'twice', 'fail'),
    res(f, 'twice', 'pass'),
  ]);
  const k = (name) => `${f} :: ${name}`;
  assert.deepEqual(diffSuites(base, next), {
    regressed: [{ test: k('breaks'), was: 'pass', error: 'boom' }],
    newFailing: [
      { test: k('new bad'), error: '' },
      { test: k('twice'), error: '' },
    ],
    fixed: [{ test: k('heals') }],
    stillFailing: [{ test: k('still'), error: '' }],
    removed: [{ test: k('gone') }],
    added: 3,
    same: 1,
  });
});

test("the suite runner rewrites a release's own test script to add the reporter and, for the NEGATIVE, its files", () => {
  const script =
    "node --test --test-timeout=180000 --test-global-setup=node_modules/x/global.mjs 'test/integration/*.test.mjs'";
  const flags =
    'node --test --test-reporter=/r.mjs --test-reporter-destination=/o.jsonl --test-reporter=spec --test-reporter-destination=stdout';
  assert.equal(
    testCommand(script, '/r.mjs', '/o.jsonl', []),
    `${flags} --test-timeout=180000 --test-global-setup=node_modules/x/global.mjs 'test/integration/*.test.mjs'`
  );
  assert.equal(
    testCommand(script, '/r.mjs', '/o.jsonl', [
      'test/integration/a.test.mjs',
      'test/integration/b.test.mjs',
    ]),
    `${flags} --test-timeout=180000 --test-global-setup=node_modules/x/global.mjs 'test/integration/a.test.mjs' 'test/integration/b.test.mjs'`
  );
  assert.equal(
    testCommand('npm run build && node --test test/', '/r.mjs', '/o.jsonl', [
      'test/integration/a.test.mjs',
    ]),
    `npm run build && ${flags} test/ 'test/integration/a.test.mjs'`
  );
  assert.throws(() => testCommand('vitest', '/r.mjs', '/o.jsonl', []), /runs no node --test/);
});

test('the reporter records every test and subtest of a real node --test run with its status and error', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-reporter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = join(dir, 'out.jsonl');
  const sample = fileURLToPath(new URL('sample.mjs', fixtures));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  spawnSync(
    process.execPath,
    [
      '--test',
      `--test-reporter=${fileURLToPath(new URL('reporter.mjs', tools))}`,
      `--test-reporter-destination=${out}`,
      sample,
    ],
    { cwd: dir, env, encoding: 'utf8' }
  );
  const got = parseResults(await readFile(out, 'utf8')).map(({ name, status, error }) => ({
    name,
    status,
    ...(error ? { error } : {}),
  }));
  const errors = Object.fromEntries(got.filter((r) => r.error).map((r) => [r.name, r.error]));
  assert.match(errors['a failing test'], /Expected values to be strictly equal/);
  assert.equal(errors['a parent > a child that fails'], 'child broke');
  assert.deepEqual(got.map(({ name, status }) => `${status} ${name}`).sort(), [
    'fail a failing test',
    'fail a parent',
    'fail a parent > a child that fails',
    'pass a parent > a child that passes',
    'pass a passing test',
    'skip a skipped test',
  ]);
});

test('the record checks the SLSA statement against the tarball, release.yml on main, a hosted builder and the gitHead', () => {
  const sha512 = 'ab'.repeat(64);
  const gitHead = 'c'.repeat(40);
  const statement = (over = {}) => ({
    subject: [
      {
        name: 'pkg:npm/%40ai-ecoverse/slicc-kernel@1.2.3',
        digest: { sha512: over.sha512 ?? sha512 },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: 'https://github.com/ai-ecoverse/slicc-kernel',
            path: over.path ?? '.github/workflows/release.yml',
            ref: over.ref ?? 'refs/heads/main',
          },
        },
        resolvedDependencies: [{ digest: { gitCommit: over.commit ?? gitHead } }],
      },
      runDetails: {
        builder: { id: over.builder ?? 'https://github.com/actions/runner/github-hosted' },
      },
    },
  });
  const check = (over) =>
    provenanceProblems(statement(over), {
      repo: 'ai-ecoverse/slicc-kernel',
      version: '1.2.3',
      sha512,
      gitHead,
    }).problems;
  assert.deepEqual(check(), []);
  assert.deepEqual(check({ sha512: 'ff'.repeat(64) }), [
    "the provenance subject isn't this tarball's sha512",
  ]);
  assert.deepEqual(check({ ref: 'refs/heads/dev' }), ['provenance ref is refs/heads/dev']);
  assert.deepEqual(check({ path: '.github/workflows/x.yml' }), [
    'provenance workflow is .github/workflows/x.yml',
  ]);
  assert.deepEqual(check({ builder: 'https://github.com/actions/runner/self-hosted' }), [
    'provenance builder is https://github.com/actions/runner/self-hosted',
  ]);
  assert.deepEqual(check({ commit: 'd'.repeat(40) }), [
    `provenance gitCommit ${'d'.repeat(40)} isn't the package's gitHead ${gitHead}`,
  ]);
  assert.deepEqual(check({ commit: 'nope' }), ['provenance gitCommit is nope']);
  assert.deepEqual(
    knownLine('ai-ecoverse/slicc-kernel', [
      'ai-ecoverse/slicc-kernel#665',
      '#665',
      ' #667 ',
      'o/r#1',
      '',
    ]),
    ['ai-ecoverse/slicc-kernel#665', 'ai-ecoverse/slicc-kernel#667', 'o/r#1']
  );
});

test('findings.mjs turns the runs into decisions, suite regressions and missing evidence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-findings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = 'test/integration/node.test.mjs';
  const write = (name, value) => writeFile(join(dir, name), JSON.stringify(value));
  await write('delta.json', { prev: '1.2.2', version: '1.2.3', rows, files: deltaFiles(rows) });
  await write('prev.json', {
    results: [
      res(file, 'a new test', 'fail'),
      res('test/integration/udp.test.mjs', 'udp echo', 'fail'),
    ],
  });
  await write('release.json', {
    results: [
      res(file, 'a new test', 'pass'),
      res(file, 'old', 'fail'),
      res('test/integration/udp.test.mjs', 'udp echo', 'pass'),
    ],
  });
  await write('base.json', { results: [res(file, 'old', 'pass')] });
  const run = (base) =>
    execFileSync(process.execPath, [
      fileURLToPath(new URL('findings.mjs', tools)),
      '--delta',
      join(dir, 'delta.json'),
      '--prev',
      join(dir, 'prev.json'),
      '--release',
      join(dir, 'release.json'),
      '--base',
      join(dir, base),
      '--out',
      join(dir, 'findings.json'),
    ]);
  run('base.json');
  const found = JSON.parse(await readFile(join(dir, 'findings.json'), 'utf8'));
  assert.deepEqual(
    found.rows.map((r) => [r.pr, r.decision]),
    [
      [12, 'negative'],
      [7, 'passes'],
      [9, 'not-behaviour'],
    ]
  );
  assert.deepEqual(found.findings, [
    { kind: 'suite-regression', test: `${file} :: old`, error: '' },
  ]);
  run('missing.json');
  const missing = JSON.parse(await readFile(join(dir, 'findings.json'), 'utf8'));
  assert.deepEqual(missing.findings[0], { kind: 'missing-evidence', what: 'the certified suite' });
});
