import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compatRegressions,
  decide,
  deltaFiles,
  diffSuites,
  knownAsOf,
  knownLine,
  mergedPrs,
  parseResults,
  provenanceProblems,
  resultsMap,
  rowOf,
  testCommand,
  titlesFromPatch,
  unquote,
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
    exit: 1,
    files: [file],
    results: [
      res(file, 'a new test', 'fail'),
      res('test/integration/udp.test.mjs', 'udp echo', 'fail'),
    ],
  });
  await write('release.json', {
    exit: 1,
    results: [
      res(file, 'a new test', 'pass'),
      res(file, 'old', 'fail'),
      res('test/integration/udp.test.mjs', 'udp echo', 'pass'),
    ],
  });
  await write('base.json', { exit: 0, results: [res(file, 'old', 'pass')] });
  const run = (base, extra = []) =>
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
      ...extra,
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
  const compat = async (value) => {
    await write('compat.json', value);
    run('base.json', ['--compat', join(dir, 'compat.json')]);
    return JSON.parse(await readFile(join(dir, 'findings.json'), 'utf8')).findings.filter(
      (f) => f.kind !== 'suite-regression'
    );
  };
  assert.deepEqual(await compat({ found: false }), [
    { kind: 'missing-evidence', what: 'kernel-compat' },
  ]);
  const reg = (over) => ({
    recipe: 'perl',
    version: '1',
    spec: 'a.mjs',
    rerun: 'pass',
    reproduced: false,
    error: 'e',
    ...over,
  });
  assert.deepEqual(await compat({ found: true, conclusion: 'success', regressions: [] }), []);
  assert.deepEqual(
    await compat({
      found: true,
      conclusion: 'failure',
      regressions: [
        reg({}),
        reg({ spec: 'b.mjs', rerun: 'regression', reproduced: true }),
        reg({
          spec: 'c.mjs',
          rerun: 'regression',
          reproduced: true,
          crashAgain: true,
          referenceCrash: false,
        }),
        reg({
          spec: 'd.mjs',
          rerun: 'regression',
          reproduced: true,
          crashAgain: true,
          referenceCrash: true,
        }),
      ],
    }),
    [
      { kind: 'compat-flake', package: 'perl@1', spec: 'a.mjs', rerun: 'pass', error: 'e' },
      {
        kind: 'compat-regression',
        package: 'perl@1',
        spec: 'b.mjs',
        rerun: 'regression',
        error: 'e',
      },
      { kind: 'compat-crash', package: 'perl@1', spec: 'c.mjs', rerun: 'regression', error: 'e' },
      {
        kind: 'compat-regression',
        package: 'perl@1',
        spec: 'd.mjs',
        rerun: 'regression',
        error: 'e',
      },
    ]
  );
  assert.deepEqual(await compat({ found: true, conclusion: 'failure', regressions: [] }), [
    {
      kind: 'compat-regression',
      package: 'unknown',
      spec: '',
      rerun: 'none',
      error: 'kernel-compat failure',
    },
  ]);
  assert.deepEqual(await compat({ found: false, planted: true }), []);
  await write('release.json', {
    exit: 'signal SIGTERM',
    results: [res(file, 'a new test', 'pass')],
  });
  run('base.json');
  const cut = JSON.parse(await readFile(join(dir, 'findings.json'), 'utf8')).findings;
  assert.deepEqual(
    cut.filter((f) => f.kind === 'suite-incomplete'),
    [{ kind: 'suite-incomplete', what: 'the release suite', exit: 'signal SIGTERM', results: 1 }]
  );
});

test('kernel-compat regressions are re-run in code: one that passes again is a flake, a crash that comes back is kept unless the reference crashes too', () => {
  const row = (spec, verdict, error, refLog) => ({
    package: '@ai-ecoverse/wasix-python',
    recipe: 'wasix-python',
    version: '3',
    spec,
    users: 'off',
    verdict,
    error,
    reference: { status: 'fail', log: refLog },
  });
  const report = {
    results: [
      row('ok.mjs', 'pass', ''),
      row('mode.mjs', 'regression', "'644' !== '755'"),
      row('sig.mjs', 'regression', 'page renderer crashed (crashed, code 11)'),
      row('ref.mjs', 'regression', 'page renderer crashed'),
      row('gone.mjs', 'regression', 'x'),
    ],
  };
  const rerun = {
    results: [
      row('mode.mjs', 'regression', "'644' !== '755'"),
      row('sig.mjs', 'regression', 'Runtime.evaluate: page renderer crashed', 'logs/sig.ref.log'),
      row('ref.mjs', 'regression', 'Segmentation fault', 'logs/ref.ref.log'),
    ],
  };
  const logs = { 'logs/ref.ref.log': 'Error: page renderer crashed (code 11)' };
  const got = compatRegressions(report, rerun, (r) => logs[r.reference.log] ?? '').map(
    ({ spec, crash, rerun: again, reproduced, crashAgain, referenceCrash }) => ({
      spec,
      crash,
      again,
      reproduced,
      crashAgain,
      referenceCrash,
    })
  );
  assert.deepEqual(got, [
    {
      spec: 'mode.mjs',
      crash: false,
      again: 'regression',
      reproduced: true,
      crashAgain: false,
      referenceCrash: false,
    },
    {
      spec: 'sig.mjs',
      crash: true,
      again: 'regression',
      reproduced: true,
      crashAgain: true,
      referenceCrash: false,
    },
    {
      spec: 'ref.mjs',
      crash: true,
      again: 'regression',
      reproduced: true,
      crashAgain: true,
      referenceCrash: true,
    },
    {
      spec: 'gone.mjs',
      crash: false,
      again: 'missing',
      reproduced: true,
      crashAgain: undefined,
      referenceCrash: undefined,
    },
  ]);
  assert.deepEqual(
    compatRegressions(report, { results: [row('mode.mjs', 'pass', '')] }).map((r) => [
      r.spec,
      r.reproduced,
    ]),
    [
      ['mode.mjs', false],
      ['sig.mjs', true],
      ['ref.mjs', true],
      ['gone.mjs', true],
    ]
  );
  assert.deepEqual(
    compatRegressions(report).map((r) => r.rerun),
    ['none', 'none', 'none', 'none']
  );
});

test('a known issue applies to a release unless its fix came before it: fixedIn, then the closing pull request, then the closing time', () => {
  const before = new Set(['old']);
  const opts = (over = {}) => ({
    fixedBefore: (oid) => before.has(oid),
    releasedAt: '2026-10-10T00:00:00Z',
    version: '1.95.3',
    ...over,
  });
  const closed = (over) => ({ state: 'CLOSED', stateReason: 'COMPLETED', closedBy: [], ...over });
  assert.equal(knownAsOf({ state: 'OPEN' }, opts()), true);
  assert.equal(
    knownAsOf(closed({ closedBy: [{ merged: true, mergeCommit: 'old' }] }), opts()),
    false
  );
  assert.equal(
    knownAsOf(closed({ closedBy: [{ merged: true, mergeCommit: 'new' }] }), opts()),
    true
  );
  assert.equal(
    knownAsOf(
      closed({
        closedBy: [{ merged: false, mergeCommit: null }],
        closedAt: '2026-10-11T00:00:00Z',
      }),
      opts()
    ),
    true
  );
  assert.equal(knownAsOf(closed({ closedAt: '2026-10-09T00:00:00Z' }), opts()), false);
  assert.equal(knownAsOf(closed({ closedAt: '2026-10-11T00:00:00Z' }), opts()), true);
  assert.equal(knownAsOf(closed({ stateReason: 'NOT_PLANNED' }), opts()), false);
  assert.equal(knownAsOf(closed({ stateReason: 'DUPLICATE' }), opts()), false);
  assert.equal(
    knownAsOf(
      closed({ closedBy: [{ merged: true, mergeCommit: 'old' }] }),
      opts({ fixedIn: '1.97.1' })
    ),
    true
  );
  assert.equal(knownAsOf({ state: 'OPEN' }, opts({ fixedIn: '1.95.3' })), false);
});

test('test titles are read as JavaScript reads them, escapes included', () => {
  assert.equal(
    unquote(String.raw`exec\u2019d by \x41 path\n\'q\' \u{1F600}`),
    "exec\u2019d by A path\n'q' \u{1F600}"
  );
  assert.deepEqual(titlesFromPatch("+test('the kernel exec\\u2019d it', () => {});"), [
    'the kernel exec\u2019d it',
  ]);
});
