import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  baseEvidence,
  baselineFiles,
  compatFindingsOf,
  compatRegressions,
  covering,
  decide,
  deltaFiles,
  diffSuites,
  droppedTests,
  gapsOf,
  gateOf,
  knownAsOf,
  knownLine,
  mergedPrs,
  missingShards,
  packageProblems,
  parseResults,
  pickRelease,
  previousPublished,
  provenanceProblems,
  publishStep,
  releaseEvidence,
  rerunSet,
  resultsMap,
  retryDecision,
  rowOf,
  testCommand,
  titlesFromPatch,
  unfinishedFiles,
  unquote,
  verdictLine,
  withBaselines,
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
        '\u2026 variable',
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
    unrun: [],
    added: 3,
    same: 1,
  });
  const cut = diffSuites(base, resultsMap([res(f, 'stays', 'pass')]), { complete: false });
  assert.deepEqual(
    [cut.removed, cut.unrun.map((u) => u.test), cut.same],
    [[], [k('breaks'), k('heals'), k('still'), k('gone')], 1]
  );
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

test('the suite runner keeps its tests in a session of their own, so a SIGINT to its process group does not end the step', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tree = join(dir, 'tree');
  await mkdir(join(tree, 'test/integration'), { recursive: true });
  await mkdir(join(dir, 'package/dist'), { recursive: true });
  await writeFile(join(dir, 'package/dist/node.js'), 'export {};\n');
  execFileSync('tar', ['-czf', join(dir, 'k.tgz'), '-C', dir, 'package']);
  await writeFile(
    join(tree, 'package.json'),
    JSON.stringify({ scripts: { test: "node --test 'test/integration/*.test.mjs'" } })
  );
  await writeFile(
    join(tree, 'test/integration/a.test.mjs'),
    "import { test } from 'node:test';\ntest('a stray group SIGINT', () => { process.kill(-Number(process.env.SUITE_PGID), 'SIGINT'); });\ntest('a later test', async () => { await new Promise((r) => setTimeout(r, 300)); });\n"
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const out = join(dir, 'out/base');
  const suite = spawn(
    'bash',
    [
      '-c',
      'export SUITE_PGID=$$; exec "$0" "$@"',
      process.execPath,
      fileURLToPath(new URL('suite.mjs', tools)),
      '--tree',
      tree,
      '--tgz',
      join(dir, 'k.tgz'),
      '--out',
      out,
    ],
    { env, detached: true, stdio: 'ignore' }
  );
  const [code, signal] = await new Promise((r) => suite.once('exit', (c, s) => r([c, s])));
  assert.deepEqual([code, signal], [0, null]);
  const summary = JSON.parse(await readFile(`${out}.json`, 'utf8'));
  assert.deepEqual(
    [summary.exit, summary.pass, summary.fail, summary.ignored],
    [0, 2, 0, ['SIGINT']]
  );
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
  assert.deepEqual(missing.findings[0], {
    kind: 'missing-evidence',
    what: 'the certified suite',
    blocking: true,
    dropped: 1,
  });
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
      kind: 'compat-incomplete',
      what: 'kernel-compat',
      shards: [],
      error: 'kernel-compat failure with no regression',
    },
  ]);
  assert.deepEqual(
    await compat({
      found: true,
      conclusion: 'failure',
      regressions: [],
      missingShards: [2],
      shardRerun: { shards: [2], conclusion: 'failure' },
    }),
    [
      {
        kind: 'compat-incomplete',
        what: 'kernel-compat',
        shards: [2],
        rerun: 'failure',
        error: 'kernel-compat failure with no regression, no report from shard 2',
      },
    ]
  );
  assert.deepEqual(await compat({ found: false, planted: true }), []);
  await write('release.json', {
    exit: 'signal SIGTERM',
    results: [res(file, 'a new test', 'pass')],
  });
  run('base.json');
  const cut = JSON.parse(await readFile(join(dir, 'findings.json'), 'utf8')).findings;
  assert.deepEqual(
    cut.filter((f) => f.what === 'the release suite'),
    [
      {
        kind: 'missing-evidence',
        what: 'the release suite',
        exit: 'signal SIGTERM',
        results: 1,
        blocking: true,
        remedy: 're-run the failed jobs',
      },
    ]
  );
});

test('an incomplete base suite is missing evidence that blocks certified, unless the release suite is complete and all-pass and the delta drops no tests', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-base-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const write = (name, value) => writeFile(join(dir, name), JSON.stringify(value));
  const a = 'test/integration/a.test.mjs';
  const plain = {
    pr: 1,
    title: 'feat: a',
    kind: 'feat',
    behaviour: true,
    tests: [{ file: a, titles: ['t'] }],
    dropped: [],
  };
  await write('prev.json', { exit: 0, files: [], results: [] });
  await write('base.json', { exit: 'signal SIGINT', results: [res(a, 't', 'pass')] });
  const findings = async (release, rowsOf) => {
    await write('delta.json', { prev: '1.0.0', version: '1.0.1', rows: rowsOf });
    await write('release.json', release);
    execFileSync(process.execPath, [
      fileURLToPath(new URL('findings.mjs', tools)),
      ...['delta', 'prev', 'release', 'base'].flatMap((k) => [`--${k}`, join(dir, `${k}.json`)]),
      '--out',
      join(dir, 'findings.json'),
    ]);
    return JSON.parse(await readFile(join(dir, 'findings.json'), 'utf8')).findings.filter(
      (f) => f.what === 'the certified suite'
    );
  };
  const green = { exit: 0, results: [res(a, 't', 'pass')] };
  const note = {
    kind: 'missing-evidence',
    what: 'the certified suite',
    exit: 'signal SIGINT',
    results: 1,
  };
  assert.deepEqual(await findings(green, [plain]), [{ ...note, blocking: false }]);
  assert.deepEqual(await findings({ exit: 1, results: [res(a, 't', 'fail')] }, [plain]), [
    { ...note, blocking: true },
  ]);
  assert.deepEqual(await findings(green, [{ ...plain, dropped: [{ file: a, title: 'old' }] }]), [
    { ...note, blocking: true, dropped: 1 },
  ]);
  assert.deepEqual(
    droppedTests([
      {
        filename: 'test/integration/n.test.mjs',
        previous_filename: 'test/integration/o.test.mjs',
        status: 'renamed',
        patch: '',
      },
      { filename: 'test/integration/g.test.mjs', status: 'removed', patch: '' },
      {
        filename: 'test/integration/k.test.mjs',
        status: 'modified',
        patch:
          "@@ -1 +1 @@\n-test('old one', () => {});\n+test('new one', () => {});\n-test('kept', () => {\n+test('kept', async () => {",
      },
      { filename: 'src/x.ts', status: 'removed', patch: '' },
    ]),
    [
      { file: 'test/integration/o.test.mjs', to: 'test/integration/n.test.mjs' },
      { file: 'test/integration/g.test.mjs' },
      { file: 'test/integration/k.test.mjs', title: 'old one' },
    ]
  );
});

test('an incomplete base goes into the line, and is a FAIL reason unless it was waived', () => {
  const base = { kind: 'missing-evidence', what: 'the certified suite', results: 30 };
  assert.deepEqual(baseEvidence([]), { note: '' });
  assert.deepEqual(baseEvidence([{ ...base, blocking: false }]), {
    note: 'base suite incomplete (30 results)',
  });
  assert.deepEqual(baseEvidence([{ ...base, blocking: true, dropped: 2 }]), {
    note: 'base suite incomplete (30 results)',
    problem:
      "the certified suite didn't finish (30 results), and the delta drops 2 test files or titles, so nothing stands in for it",
  });
});

test('a kernel-compat shard that left no report is named, from the jobs and the artifacts of the run (#732 follow-up)', () => {
  const jobs = [
    'release / plan',
    'release / shard (0)',
    'release / shard (2)',
    'release / shard (1)',
    'release / gate',
  ].map((name) => ({ name }));
  const artifacts = [
    'kernel-compat-abc-shard-0',
    'kernel-compat-abc-shard-1',
    'kernel-compat-abc',
    'kernel-compat-abc-plan',
  ];
  assert.deepEqual(missingShards(jobs, artifacts), [2]);
  assert.deepEqual(missingShards(jobs, [...artifacts, 'kernel-compat-abc-shard-2']), []);
});

test('a fix whose bug shipped inside the delta gets its NEGATIVE from the release before the fix, not from prev (#732)', async (t) => {
  const commits = ['a', 'b', 'c', 'd', 'e'].map((sha) => ({ sha }));
  const tags = [
    { version: '1.0.2', sha: 'd' },
    { version: '1.0.1', sha: 'b' },
    { version: '0.9.0', sha: 'z' },
  ];
  const row = (pr, kind, merged, file) => ({
    pr,
    title: `${kind}: ${pr}`,
    kind,
    behaviour: true,
    tests: [{ file, titles: [`t${pr}`] }],
    ...(merged ? { merged } : {}),
  });
  const placed = withBaselines(
    [
      row(1, 'fix', 'a', 'test/integration/a.test.mjs'),
      row(2, 'fix', 'c', 'test/integration/c.test.mjs'),
      row(3, 'fix', 'e', 'test/integration/e.test.mjs'),
      row(4, 'fix', undefined, 'test/integration/x.test.mjs'),
      row(5, 'feat', 'e', 'test/integration/f.test.mjs'),
    ],
    { commits, tags, prev: '1.0.0' }
  );
  assert.deepEqual(
    placed.map((r) => [r.pr, r.baseline]),
    [
      [1, '1.0.0'],
      [2, '1.0.1'],
      [3, '1.0.2'],
      [4, '1.0.0'],
      [5, '1.0.2'],
    ]
  );
  assert.deepEqual(baselineFiles(placed, '1.0.0'), {
    '1.0.0': ['test/integration/a.test.mjs', 'test/integration/x.test.mjs'],
    '1.0.1': ['test/integration/c.test.mjs'],
    '1.0.2': ['test/integration/e.test.mjs'],
  });
  const dir = await mkdtemp(join(tmpdir(), 'cert-baseline-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const write = (name, value) => writeFile(join(dir, name), JSON.stringify(value));
  const two = placed.filter((r) => r.pr === 1 || r.pr === 2);
  await write('delta.json', {
    prev: '1.0.0',
    version: '1.0.3',
    rows: two,
    baselines: baselineFiles(two, '1.0.0'),
  });
  const a = 'test/integration/a.test.mjs';
  const c = 'test/integration/c.test.mjs';
  await write('prev.json', { exit: 1, files: [a], results: [res(a, 't1', 'fail')] });
  await write('release.json', { exit: 0, results: [res(a, 't1', 'pass'), res(c, 't2', 'pass')] });
  await write('base.json', { exit: 0, results: [res(a, 't1', 'pass')] });
  const run = () => {
    execFileSync(process.execPath, [
      fileURLToPath(new URL('findings.mjs', tools)),
      ...['--delta', 'delta.json', '--prev', 'prev.json', '--release', 'release.json'].map((x) =>
        x.endsWith('.json') ? join(dir, x) : x
      ),
      '--base',
      join(dir, 'base.json'),
      '--out',
      join(dir, 'findings.json'),
    ]);
    return JSON.parse(execFileSync('cat', [join(dir, 'findings.json')], { encoding: 'utf8' }));
  };
  const lost = run();
  assert.deepEqual(
    lost.findings.filter((f) => f.kind === 'missing-evidence'),
    [{ kind: 'missing-evidence', what: 'the v1.0.1 run' }]
  );
  await write('prev-1.0.1.json', { exit: 1, files: [c], results: [res(c, 't2', 'fail')] });
  const found = run();
  assert.deepEqual(
    found.rows.map((r) => [r.pr, r.decision, r.baseline]),
    [
      [1, 'negative', undefined],
      [2, 'negative', '1.0.1'],
    ]
  );
  assert.deepEqual(found.findings, []);
  assert.deepEqual(Object.keys(found.runs), ['prev', 'prev-1.0.1', 'release', 'base']);
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

test('test gaps go into the line in code, so a fix without a NEGATIVE is never certified silently', () => {
  assert.deepEqual(
    gapsOf([
      { kind: 'no-negative', pr: 712 },
      { kind: 'no-test', pr: 714 },
      { kind: 'suite-regression', test: 'x' },
      { kind: 'missing-evidence', what: 'kernel-compat' },
      { kind: 'prev-not-run', pr: 9 },
    ]),
    ['#712 no-negative', '#714 no-test', '#9 prev-not-run']
  );
  assert.deepEqual(gapsOf(undefined), []);
});

test('prev and base: the newest earlier release whose cert-review passed (prev also takes a pending one), past failures and unreviewed releases', async () => {
  const states = {
    '1.98.4': undefined,
    '1.98.3': 'failure',
    '1.98.5': 'error',
    '1.98.2': 'success',
    '1.98.1': 'success',
    '1.99.1': 'pending',
  };
  const tags = ['1.98.1', '1.98.2', '1.98.3', '1.98.4', '1.98.5', '1.99.0', '1.99.1', '1.99.2'];
  const stateOf = async (t) => states[t];
  assert.equal(await pickRelease(tags, '1.99.0', stateOf), '1.98.2');
  assert.equal(await pickRelease(tags, '1.99.0', stateOf, { pending: true }), '1.98.2');
  assert.equal(await pickRelease(tags, '1.99.2', stateOf, { pending: true }), '1.99.1');
  assert.equal(await pickRelease(tags, '1.99.2', stateOf), '1.98.2');
  assert.equal(await pickRelease(tags, '1.98.1', stateOf), undefined);
  assert.deepEqual(covering(tags, '1.98.2', '1.99.1'), [
    '1.98.3',
    '1.98.4',
    '1.98.5',
    '1.99.0',
    '1.99.1',
  ]);
  assert.deepEqual(covering(tags, '1.99.0', '1.99.1'), ['1.99.1']);
});

test("kernel-compat's reference for a cert review is the certified base: cert-review passes it, kernel-compat names it and hands it to homescoop", async () => {
  const read = (name) =>
    readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
  const cert = await read('cert-review.yml');
  const compat = await read('kernel-compat.yml');
  assert.match(
    cert,
    /BASE: \$\{\{ needs\.plan\.outputs\.base \}\}\n {8}run: \|[\s\S]*?--reference "\$BASE"/
  );
  assert.match(
    compat,
    /\n {6}reference:\n {8}description: [^\n]+\n {8}type: string\n {8}default: ''/
  );
  assert.match(compat, /inputs\.reference != '' && format\(' ref \{0\}', inputs\.reference\)/);
  assert.match(compat, /\n {6}reference: \$\{\{ inputs\.reference \|\| '' \}\}\n/);
  const tool = await readFile(new URL('compat.mjs', tools), 'utf8');
  assert.match(
    tool,
    /`Kernel compat v\$\{version\}\$\{sha256 \? ` \$\{sha256\}` : ''\}\$\{reference \? ` ref \$\{reference\}` : ''\}`/
  );
  assert.match(
    compat,
    /format\('Kernel compat v\{0\}\{1\}\{2\}\{3\}', inputs\.version, inputs\.sha256 != '' && format\(' \{0\}', inputs\.sha256\)/
  );
  assert.match(cert, /--ref "\$REF" --run "\$RUN_ID" --artifact "\$ARTIFACT" --sha256 "\$SHA256"/);
});

const workflowText = (name) =>
  readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');

const jobsOf = (workflow) => {
  const body = workflow.split(/^jobs:$/m)[1] ?? '';
  const out = {};
  for (const m of body.matchAll(/^ {2}([a-z-]+):\n([\s\S]*?)(?=^ {2}[a-z-]+:$|(?![\s\S]))/gm))
    out[m[1]] = m[2];
  return out;
};

test('the whole Release run is serialized: one workflow-level group, never cancelled, push to main only', async () => {
  const release = await workflowText('release.yml');
  assert.match(release, /^concurrency:\n {2}group: release\n {2}cancel-in-progress: false$/m);
  assert.doesNotMatch(release, /workflow_dispatch/);
  assert.match(release, /^on:\n {2}push:\n {4}branches: \[main\]\n\n/m);
  const jobs = jobsOf(release);
  assert.deepEqual(Object.keys(jobs), [
    'tag',
    'pack',
    'cert',
    'publish',
    'verify',
    'not-published',
  ]);
  for (const [name, body] of Object.entries(jobs)) {
    assert.match(
      body,
      /^ {4}if: [\s\S]*?github\.ref == 'refs\/heads\/main'/m,
      `${name} is main-only`
    );
    assert.doesNotMatch(body, /^ {4}concurrency:/m, `${name} has no job-level group`);
  }
  const review = await workflowText('cert-review.yml');
  assert.doesNotMatch(review, /workflow_run/);
  assert.match(review, /^ {2}workflow_call:\n/m);
});

test('id-token: write is only on release / publish, a GitHub-hosted job that publishes the certified, same-sha artifact', async () => {
  for (const name of ['cert-review.yml', 'kernel-compat.yml', 'ci.yml']) {
    assert.doesNotMatch(await workflowText(name), /id-token/, `${name} has no id-token`);
  }
  const jobs = jobsOf(await workflowText('release.yml'));
  const holders = Object.entries(jobs)
    .filter(([, body]) => /id-token: write/.test(body))
    .map(([name]) => name);
  assert.deepEqual(holders, ['publish']);
  assert.match(jobs.publish, /^ {4}runs-on: ubuntu-latest$/m);
  assert.match(jobs.pack, /^ {4}runs-on: ubuntu-latest$/m);
  assert.doesNotMatch(jobs.pack, /id-token|secrets\./);
  assert.match(jobs.publish, /^ {4}needs: \[tag, pack, cert\]$/m);
  assert.match(jobs.publish, /!cancelled\(\) && github\.ref == 'refs\/heads\/main' &&/);
  assert.match(
    jobs.publish,
    /needs\.pack\.result == 'success' && needs\.cert\.result == 'success' &&/
  );
  assert.match(jobs.publish, /needs\.cert\.outputs\.conclusion == 'success' &&/);
  assert.match(jobs.publish, /needs\.cert\.outputs\.sha256 != '' &&/);
  assert.match(jobs.publish, /needs\.cert\.outputs\.sha256 == needs\.pack\.outputs\.sha256/);
  assert.match(jobs.publish, /name: \$\{\{ needs\.pack\.outputs\.artifact \}\}/);
  assert.match(
    jobs.publish,
    /publish\.mjs --tarball "\$TGZ" --record "\$RUNNER_TEMP\/record\/record\.json" --sha256 "\$SHA256"$/m
  );
  assert.doesNotMatch(jobs.publish, /--dry-run|secrets\./);
  assert.match(jobs.cert, /uses: \.\/\.github\/workflows\/cert-review\.yml/);
  assert.match(jobs.cert, /artifact: \$\{\{ needs\.pack\.outputs\.artifact \}\}/);
  assert.match(jobs.cert, /sha256: \$\{\{ needs\.pack\.outputs\.sha256 \}\}/);
  assert.doesNotMatch(await workflowText('release.yml'), /secrets: inherit/);
  assert.match(
    jobs.cert,
    /^ {4}secrets:\n {6}AWS_BEARER_TOKEN_BEDROCK: \$\{\{ secrets\.AWS_BEARER_TOKEN_BEDROCK \}\}\n(?! {6})/m
  );
  const review = await workflowText('cert-review.yml');
  assert.deepEqual(
    [...review.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]),
    ['AWS_BEARER_TOKEN_BEDROCK']
  );
  assert.match(
    review,
    /^ {10}AWS_BEARER_TOKEN_BEDROCK: \$\{\{ secrets\.AWS_BEARER_TOKEN_BEDROCK \}\}$/m
  );
  assert.match(jobs.verify, /needs\.publish\.outputs\.outcome == 'published'/);
  assert.match(jobs.verify, /published\.mjs .*--sha256 "\$SHA256"/);
  assert.match(jobs['not-published'], /needs\.publish\.outputs\.outcome != 'published'/);
});

test('a cert-review dispatch is a dry run: only a release run writes the status, files issues or reaches npm', async () => {
  const review = await workflowText('cert-review.yml');
  const jobs = jobsOf(review);
  assert.doesNotMatch(review, /dry_run/);
  assert.match(jobs.status, /needs\.plan\.outputs\.mode == 'release'/);
  assert.match(jobs.plan, /if: steps\.plan\.outputs\.mode == 'release'\n[\s\S]*state: "pending"/);
  const writers = Object.entries(jobs)
    .filter(([, body]) => /\/statuses\//.test(body))
    .map(([name]) => name);
  assert.deepEqual(writers, ['plan', 'status']);
  assert.doesNotMatch(review, /always\(\)/);
  assert.match(
    jobs.review,
    /FILING: \$\{\{ github\.ref == 'refs\/heads\/main' && needs\.plan\.outputs\.mode == 'release' && 'on' \|\| 'off' \}\}/
  );
  assert.match(
    jobs.review,
    /needs\.plan\.outputs\.mode == 'release' && ',Bash\(gh issue create:\*\)'/
  );
  assert.match(jobs.pack, /needs\.plan\.outputs\.mode == 'dispatch'/);
  assert.match(jobs.gate, /needs\.plan\.outputs\.mode == 'dispatch'/);
  assert.match(jobs.gate, /publish\.mjs --dry-run /);
  assert.match(jobs.plan, /a release review runs only on main/);
  assert.match(jobs.record, /if: steps\.record\.outputs\.conclusion != 'success'\n[\s\S]*?exit 1/);
  assert.match(jobs.status, /needs\.record\.outputs\.conclusion != ''/);
  assert.match(
    jobs.record,
    /JOBS: tarball=\$\{\{ needs\.tarball\.result \}\},suite=\$\{\{ needs\.suite\.result \}\},kernel-compat=\$\{\{ needs\.compat\.result \}\}/
  );
  assert.match(jobs.record, /--review-result "\$REVIEW" --jobs "\$JOBS"/);
  assert.match(jobs.gate, /needs\.record\.outputs\.conclusion != ''/);
});

const tarballOf = async (dir, manifest) => {
  const root = join(dir, `pkg-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(root, 'package'), { recursive: true });
  await writeFile(join(root, 'package', 'package.json'), JSON.stringify(manifest));
  const file = join(root, 'kernel.tgz');
  execFileSync('tar', ['-czf', file, '-C', root, 'package']);
  const { createHash } = await import('node:crypto');
  return {
    file,
    sha256: createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
  };
};

test('the publish gate refuses anything but a certified record of exactly the packed bytes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const name = '@ai-ecoverse/slicc-kernel';
  const ok = await tarballOf(dir, { name, version: '1.2.3', gitHead: 'c'.repeat(40) });
  const other = await tarballOf(dir, { name, version: '1.2.3', gitHead: 'd'.repeat(40) });
  const line = (sha) => `certified ${name}@1.2.3 sha256=${sha} (ci: x; known: none)`;
  const record = (over = {}) => ({
    version: '1.2.3',
    certified: true,
    sha256: ok.sha256,
    line: line(ok.sha256),
    ...over,
  });
  const manifest = { name, version: '1.2.3' };
  const why = (r, sha256 = ok.sha256, packed = ok.sha256, m = manifest) =>
    gateOf({ record: r, sha256, packed, manifest: m }).why;
  assert.equal(why(record()), undefined);
  assert.equal(why(undefined), 'no cert-review record');
  assert.equal(
    why(record({ certified: false, line: `cert-ci: FAIL ${name}@1.2.3: x` })),
    'the verdict is not certified'
  );
  assert.match(why(record({ planted: 'proof/x' })), /planted build of proof\/x/);
  assert.match(
    why(record(), other.sha256, other.sha256),
    /the record's sha256 .* is not the tarball's/
  );
  assert.match(
    why(record(), ok.sha256, other.sha256),
    /the pack job's sha256 .* is not the tarball's/
  );
  assert.match(why(record(), ok.sha256, ''), /the pack job's sha256 \(none\)/);
  assert.equal(
    why(record({ line: line(other.sha256) })),
    "the line doesn't name the tarball's sha256"
  );
  assert.equal(
    why(record({ version: '1.2.4', line: line(ok.sha256).replace('1.2.3', '1.2.4') })),
    `the tarball is ${name}@1.2.3`
  );
  assert.equal(why(record({ version: 'latest' })), 'the record\'s version is "latest"');

  const publish = (args) =>
    spawnSync(process.execPath, [fileURLToPath(new URL('publish.mjs', tools)), ...args], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' },
    });
  const write = async (r) => {
    const file = join(dir, `record-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(file, JSON.stringify(r));
    return file;
  };
  for (const [r, tgz, packed, refusal] of [
    [
      record({ certified: false, line: 'cert-ci: FAIL' }),
      ok.file,
      ok.sha256,
      /the verdict is not certified/,
    ],
    [record(), other.file, other.sha256, /the record's sha256/],
    [record(), ok.file, other.sha256, /the pack job's sha256/],
    [record({ planted: 'proof/x' }), ok.file, ok.sha256, /planted build/],
  ]) {
    for (const dry of [[], ['--dry-run']]) {
      const run = publish([
        ...dry,
        '--tarball',
        tgz,
        '--record',
        await write(r),
        '--sha256',
        packed,
      ]);
      assert.equal(run.status, 2, run.stdout + run.stderr);
      assert.match(run.stdout, refusal);
      assert.match(run.stdout, /refuse to publish/);
      assert.doesNotMatch(run.stdout + run.stderr, /npm (publish|notice)/);
    }
  }
  const none = publish([
    '--tarball',
    join(dir, 'missing.tgz'),
    '--record',
    await write(record()),
    '--sha256',
    ok.sha256,
  ]);
  assert.equal(none.status, 2);
  assert.match(none.stdout, /no tarball/);
});

test('publish.mjs fails closed when npm cannot be read, publishes a newer certified version once, and skips an older one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-publish-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'npm'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const [cmd, ...rest] = process.argv.slice(2);
const e = process.env;
if (cmd === 'publish') { fs.appendFileSync(e.FAKE_LOG, rest.join(' ') + '\\n'); process.exit(0); }
if (cmd !== 'view') process.exit(3);
if (rest.includes('dist-tags.latest')) {
  if (e.FAKE_LATEST_FAIL) { console.error('npm error code ETIMEDOUT'); process.exit(1); }
  console.log(e.FAKE_LATEST ?? '');
  process.exit(0);
}
if (e.FAKE_VERSION_FAIL) { console.error('npm error code ECONNRESET'); process.exit(1); }
if (e.FAKE_ON_NPM) { console.log(e.FAKE_ON_NPM); process.exit(0); }
console.error('npm error code E404\\nnpm error 404 No match found for version 1.2.3');
process.exit(1);
`,
    { mode: 0o755 }
  );
  const name = '@ai-ecoverse/slicc-kernel';
  const ok = await tarballOf(dir, { name, version: '1.2.3', gitHead: 'c'.repeat(40) });
  const recordFile = join(dir, 'record.json');
  await writeFile(
    recordFile,
    JSON.stringify({
      version: '1.2.3',
      certified: true,
      sha256: ok.sha256,
      line: `certified ${name}@1.2.3 sha256=${ok.sha256} (ci: x; known: none)`,
    })
  );
  let n = 0;
  const publish = async (env, dry = false) => {
    const log = join(dir, `npm-${n++}.log`);
    await writeFile(log, '');
    const out = join(dir, `out-${n}`);
    const run = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('publish.mjs', tools)),
        ...(dry ? ['--dry-run'] : []),
        '--tarball',
        ok.file,
        '--record',
        recordFile,
        '--sha256',
        ok.sha256,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_LOG: log,
          GITHUB_OUTPUT: out,
          GITHUB_STEP_SUMMARY: '',
          ...env,
        },
      }
    );
    const outcome = /outcome=(\w[\w-]*)/.exec(await readFile(out, 'utf8').catch(() => ''))?.[1];
    return {
      status: run.status,
      stdout: run.stdout,
      outcome,
      published: await readFile(log, 'utf8'),
    };
  };
  for (const dry of [false, true]) {
    const down = await publish({ FAKE_LATEST_FAIL: '1' }, dry);
    assert.equal(down.status, 2, down.stdout);
    assert.match(
      down.stdout,
      /dist-tags\.latest failed \(npm error code ETIMEDOUT\), so the latest check can't run/
    );
    assert.equal(down.published, '');
    const empty = await publish({ FAKE_LATEST: '' }, dry);
    assert.equal(empty.status, 2);
    assert.match(empty.stdout, /npm's latest reads as "", not x\.y\.z/);
    assert.equal(empty.published, '');
    const version = await publish({ FAKE_LATEST: '1.2.2', FAKE_VERSION_FAIL: '1' }, dry);
    assert.equal(version.status, 2);
    assert.match(
      version.stdout,
      /npm view @ai-ecoverse\/slicc-kernel@1\.2\.3 failed \(npm error code ECONNRESET\)/
    );
    assert.equal(version.published, '');
  }
  const fresh = await publish({ FAKE_LATEST: '1.2.2' });
  assert.equal(fresh.status, 0, fresh.stdout);
  assert.equal(fresh.outcome, 'published');
  assert.equal(fresh.published, `${ok.file} --provenance --access public --tag latest\n`);
  const older = await publish({ FAKE_LATEST: '1.3.0' });
  assert.equal(older.status, 0);
  assert.equal(older.outcome, 'skipped');
  assert.match(
    older.stdout,
    /skip, not published to npm: v1\.2\.3 is older than npm's latest 1\.3\.0/
  );
  assert.equal(older.published, '');
  const olderDry = await publish({ FAKE_LATEST: '1.3.0' }, true);
  assert.equal(olderDry.outcome, 'skipped');
  assert.equal(
    olderDry.published,
    `${ok.file} --provenance --access public --tag latest --dry-run --force\n`
  );
});

test("npm's latest only moves forward: an older version is skipped, the same version is published once, with the same bytes", () => {
  const step = (over) =>
    publishStep({
      version: '1.2.3',
      latest: '1.2.2',
      onNpm: '',
      ours: 'sha512-a',
      dryRun: false,
      ...over,
    });
  assert.deepEqual(step(), { action: 'publish', force: false });
  assert.equal(step({ latest: '' }).action, 'refuse');
  assert.equal(step({ latest: undefined, dryRun: true }).action, 'refuse');
  assert.equal(step({ latest: '1.3.0' }).action, 'skip');
  assert.match(step({ latest: '1.2.10' }).why, /v1\.2\.3 is older than npm's latest 1\.2\.10/);
  assert.equal(step({ latest: '1.3.0', dryRun: true }).action, 'skip');
  assert.equal(step({ latest: '1.2.3', onNpm: 'sha512-a' }).action, 'done');
  assert.equal(step({ latest: '1.2.3', onNpm: 'sha512-b' }).action, 'refuse');
  assert.deepEqual(
    (({ action, force }) => ({ action, force }))(
      step({ latest: '1.2.3', onNpm: 'sha512-b', dryRun: true })
    ),
    { action: 'publish', force: true }
  );
});

test("record certifies only the pack job's bytes of the tag commit, never a planted build; missing evidence is INCOMPLETE (NOT REVIEWED after a retry), and only a defect found in code FAILs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-record-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
if (a.includes('graphql')) console.log(JSON.stringify({ data: { repository: { issue: { state: 'OPEN', stateReason: null, closedAt: null, closedByPullRequestsReferences: { nodes: [] } } } } }));
else if (a.includes('--slurp')) console.log('[[]]');
else if (a.includes('/compare/')) console.log(JSON.stringify({ status: process.env.FAKE_COMPARE || 'identical' }));
else if (a.includes('/commits/')) console.log(JSON.stringify({ commit: { committer: { date: '2026-01-01T00:00:00Z' } } }));
else process.exit(1);
`,
    { mode: 0o755 }
  );
  const commit = 'c'.repeat(40);
  const name = '@ai-ecoverse/slicc-kernel';
  const ok = await tarballOf(dir, { name, version: '1.2.3', gitHead: commit });
  const stale = await tarballOf(dir, { name, version: '1.2.3', gitHead: 'e'.repeat(40) });
  const review = join(dir, 'review');
  await mkdir(review);
  await writeFile(
    join(review, 'verdict.json'),
    JSON.stringify({ verdict: 'certified', known: [] })
  );
  let n = 0;
  const record = async (args, env = {}) => {
    const out = join(dir, `out-${n++}`);
    const run = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('record.mjs', tools)),
        '--version',
        '1.2.3',
        '--review',
        review,
        '--out',
        out,
        '--commit',
        commit,
        ...args,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_RUN_ATTEMPT: '1',
          ...env,
          PATH: `${bin}:${process.env.PATH}`,
        },
      }
    );
    const json = JSON.parse(await readFile(join(out, 'record.json'), 'utf8'));
    return { status: run.status, json };
  };
  const good = await record(['--tarball', ok.file, '--sha256', ok.sha256]);
  assert.equal(good.status, 0, JSON.stringify(good.json.problems));
  assert.equal(good.json.certified, true);
  assert.equal(good.json.sha256, ok.sha256);
  assert.match(good.json.line, new RegExp(`^certified ${name}@1\\.2\\.3 sha256=${ok.sha256} `));
  const swapped = await record(['--tarball', ok.file, '--sha256', stale.sha256]);
  assert.equal(swapped.status, 1);
  assert.match(
    swapped.json.line,
    /^cert-ci: FAIL .*the artifact's sha256 .* is not the pack job's/
  );
  const head = await record(['--tarball', stale.file, '--sha256', stale.sha256]);
  assert.equal(head.status, 1);
  assert.match(head.json.line, /the tarball's gitHead is e{40}, the tag commit is c{40}/);
  const planted = await record([
    '--tarball',
    ok.file,
    '--sha256',
    ok.sha256,
    '--planted',
    'proof/x',
  ]);
  assert.equal(planted.status, 1);
  assert.equal(planted.json.planted, 'proof/x');
  assert.match(planted.json.line, /planted build of proof\/x: never certified/);
  const held = await record([
    '--tarball',
    ok.file,
    '--sha256',
    ok.sha256,
    '--review-result',
    'failure',
  ]);
  assert.equal(held.status, 1);
  assert.match(
    held.json.line,
    /^cert-ci: INCOMPLETE .*the review job ended failure; re-run the failed jobs/
  );
  assert.equal(held.json.state, 'error');
  const lost = await record([
    '--tarball',
    ok.file,
    '--sha256',
    ok.sha256,
    '--jobs',
    'tarball=success,suite=failure,kernel-compat=failure',
  ]);
  assert.equal(lost.status, 1);
  assert.equal(lost.json.certified, false);
  assert.match(
    lost.json.line,
    /^cert-ci: INCOMPLETE @ai-ecoverse\/slicc-kernel@1\.2\.3 \(the suite job ended failure; the kernel-compat job ended failure; re-run the failed jobs\)/
  );
  const allGreen = await record([
    '--tarball',
    ok.file,
    '--sha256',
    ok.sha256,
    '--jobs',
    'tarball=success,suite=success,kernel-compat=success',
  ]);
  assert.equal(allGreen.status, 0);
  const none = join(dir, 'no-review');
  await mkdir(none);
  const lost104 = [
    '--tarball',
    ok.file,
    '--sha256',
    ok.sha256,
    '--review',
    none,
    '--review-result',
    'failure',
    '--jobs',
    'tarball=success,suite=skipped,kernel-compat=skipped',
  ];
  const shape = await record(lost104);
  assert.equal(shape.status, 1);
  assert.equal(shape.json.state, 'error');
  assert.equal(shape.json.certified, false);
  assert.match(
    shape.json.line,
    /^cert-ci: INCOMPLETE @ai-ecoverse\/slicc-kernel@1\.2\.3 \(the suite job ended skipped; the kernel-compat job ended skipped; the review job ended failure; no readable verdict\.json; re-run the failed jobs\)/
  );
  const retried = await record(lost104, { GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(retried.json.state, 'error');
  assert.match(
    retried.json.line,
    /^cert-ci: NOT REVIEWED @ai-ecoverse\/slicc-kernel@1\.2\.3: still incomplete after a retry \(.*no readable verdict\.json\); not published/
  );
  const findingsFile = async (findings) => {
    const file = join(dir, `findings-${n}.json`);
    await writeFile(file, JSON.stringify({ findings }));
    return file;
  };
  const baseCut = await record([
    '--tarball',
    ok.file,
    '--sha256',
    ok.sha256,
    '--findings',
    await findingsFile([
      {
        kind: 'missing-evidence',
        what: 'the certified suite',
        blocking: true,
        results: 3,
        dropped: 2,
      },
    ]),
  ]);
  assert.equal(baseCut.json.state, 'error');
  assert.match(
    baseCut.json.line,
    /^cert-ci: INCOMPLETE .*the certified suite didn't finish \(3 results\), and the delta drops 2 test files or titles/
  );
  const failReview = join(dir, 'fail-review');
  await mkdir(failReview);
  await writeFile(
    join(failReview, 'verdict.json'),
    JSON.stringify({ verdict: 'fail', reason: 'x' })
  );
  const reviewerFail = await record([
    '--tarball',
    ok.file,
    '--sha256',
    ok.sha256,
    '--review',
    failReview,
    '--jobs',
    'suite=failure',
  ]);
  assert.equal(reviewerFail.json.state, 'error');
  assert.match(reviewerFail.json.line, /^cert-ci: INCOMPLETE /);
  const crash = await record([
    '--tarball',
    ok.file,
    '--sha256',
    ok.sha256,
    '--jobs',
    'suite=failure',
    '--findings',
    await findingsFile([{ kind: 'compat-crash', package: 'py-x', spec: 'import' }]),
  ]);
  assert.equal(crash.json.state, 'failure');
  assert.match(crash.json.line, /^cert-ci: FAIL .*py-x import crashes again/);
  const missing = await record(['--tarball', join(dir, 'nope.tgz'), '--sha256', ok.sha256]);
  assert.equal(missing.status, 1);
  assert.match(missing.json.line, /no tarball artifact to review/);
  const off = await record(['--tarball', ok.file, '--sha256', ok.sha256], {
    FAKE_COMPARE: 'ahead',
  });
  assert.equal(off.status, 1);
  assert.match(off.json.line, /c{40} is ahead of main/);
});

test('prev is the newest earlier tag npm serves, so a FAILed, never-published tag is never a baseline and the next line covers it', () => {
  const tags = ['1.0.0', '1.0.1', '1.0.2', '1.1.0', '1.1.1'];
  assert.equal(previousPublished(tags, ['1.0.0', '1.0.1', '1.1.0'], '1.1.1'), '1.1.0');
  assert.equal(previousPublished(tags, ['1.0.0', '1.0.1'], '1.1.1'), '1.0.1');
  assert.equal(previousPublished(tags, ['1.0.0', '1.0.1', '1.1.0'], '1.1.0'), '1.0.1');
  assert.equal(previousPublished(tags, ['1.1.1'], '1.0.0'), undefined);
  const failedBetween = previousPublished(tags, ['1.0.0', '1.0.1'], '1.1.1');
  assert.deepEqual(covering(tags, failedBetween, '1.1.1'), ['1.0.2', '1.1.0', '1.1.1']);
  assert.deepEqual(
    packageProblems(
      { name: '@ai-ecoverse/slicc-kernel', version: '1.2.3', gitHead: 'a' },
      { version: '1.2.3', commit: 'a' }
    ),
    []
  );
  assert.equal(
    packageProblems(
      { name: 'x', version: '1.2.3', gitHead: 'b' },
      { version: '1.2.3', commit: 'a' }
    ).length,
    2
  );
});

test('review, record, status and the gate never start once the run is cancelled: they use !cancelled(), never always()', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/cert-review.yml', import.meta.url),
    'utf8'
  );
  const jobs = workflow.split(/^jobs:$/m)[1];
  for (const name of ['tarball', 'review', 'record', 'status', 'gate']) {
    const body =
      new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:$|(?![\\s\\S]))`, 'm').exec(jobs)?.[1] ??
      '';
    assert.ok(body.length > 0, `${name} job`);
    assert.doesNotMatch(body, /always\(\)/, `${name} uses always()`);
    assert.match(
      body,
      /^ {4}if: (\$\{\{ |>-\n\s+)!cancelled\(\)/m,
      `${name} starts with !cancelled()`
    );
  }
});

test('the review runs in a Release run (a push event, from the merge queue): the base action, with no event or actor check, runs Claude', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/cert-review.yml', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(workflow, /uses: anthropics\/claude-code-action@/);
  const step =
    /uses: anthropics\/claude-code-action\/base-action@([0-9a-f]{40})\n {8}env:\n([\s\S]*?)\n {8}with:\n([\s\S]*?)\n {6}- /.exec(
      workflow
    ) ?? [];
  assert.ok(step[1], 'pinned base-action');
  assert.match(step[2], /AWS_BEARER_TOKEN_BEDROCK: \$\{\{ secrets\.AWS_BEARER_TOKEN_BEDROCK \}\}/);
  assert.match(step[3], /^ {10}use_bedrock: 'true'$/m);
  assert.match(step[3], /^ {10}prompt: \$\{\{ steps\.findings\.outputs\.prompt \}\}$/m);
  assert.doesNotMatch(step[3], /github_token|allowed_bots/);
});

test('a suite runner stopped with SIGTERM still writes its partial results, its summary and the log so far (#743)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-term-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tree = join(dir, 'tree');
  await mkdir(join(tree, 'test/integration'), { recursive: true });
  await mkdir(join(dir, 'package/dist'), { recursive: true });
  await writeFile(join(dir, 'package/dist/node.js'), 'export {};\n');
  execFileSync('tar', ['-czf', join(dir, 'k.tgz'), '-C', dir, 'package']);
  await writeFile(
    join(tree, 'package.json'),
    JSON.stringify({ scripts: { test: "node --test 'test/integration/*.test.mjs'" } })
  );
  await writeFile(
    join(tree, 'test/integration/a.test.mjs'),
    "import { test } from 'node:test';\ntest('done first', () => { console.log('first ran'); });\ntest('still running', async () => { await new Promise((r) => setTimeout(r, 20000)); });\n"
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const out = join(dir, 'out/release');
  const suite = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('suite.mjs', tools)),
      '--tree',
      tree,
      '--tgz',
      join(dir, 'k.tgz'),
      '--out',
      out,
    ],
    { env, stdio: 'ignore' }
  );
  const exited = new Promise((r) => suite.once('exit', (c, s) => r([c, s])));
  for (let i = 0; i < 200; i++) {
    const partial = await readFile(`${out}.jsonl`, 'utf8').catch(() => '');
    if (partial.includes('done first')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  suite.kill('SIGTERM');
  assert.deepEqual(await exited, [143, null]);
  const summary = JSON.parse(await readFile(`${out}.json`, 'utf8'));
  assert.equal(summary.exit, 'signal SIGTERM');
  assert.deepEqual(
    summary.results.filter((r) => r.status === 'pass').map((r) => r.name),
    ['done first']
  );
  assert.match(await readFile(`${out}.log`, 'utf8'), /first ran/);
});

test('a release suite cut off partway is missing evidence that always blocks, and its unrun tests are not removed (#743)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-cut-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = 'test/integration/node.test.mjs';
  const other = 'test/integration/wasi.test.mjs';
  const write = (name, value) => writeFile(join(dir, name), JSON.stringify(value));
  await write('delta.json', { prev: '1.2.2', version: '1.2.3', rows, files: deltaFiles(rows) });
  await write('prev.json', { exit: 1, files: [file], results: [res(file, 'a new test', 'fail')] });
  await writeFile(
    join(dir, 'release.jsonl'),
    [res(file, 'a new test', 'pass'), res(file, 'old', 'pass'), res(other, 'w1', 'cancelled')]
      .map((r) => JSON.stringify(r))
      .join('\n')
  );
  await write('base.json', {
    exit: 0,
    results: [res(file, 'old', 'pass'), res(other, 'w1', 'pass'), res(other, 'w2', 'pass')],
  });
  execFileSync(process.execPath, [
    fileURLToPath(new URL('findings.mjs', tools)),
    '--delta',
    join(dir, 'delta.json'),
    '--prev',
    join(dir, 'prev.json'),
    '--release',
    join(dir, 'release.json'),
    '--base',
    join(dir, 'base.json'),
    '--out',
    join(dir, 'findings.json'),
  ]);
  const out = JSON.parse(await readFile(join(dir, 'findings.json'), 'utf8'));
  const release = out.findings.filter((f) => f.what === 'the release suite');
  assert.deepEqual(release, [
    {
      kind: 'missing-evidence',
      what: 'the release suite',
      exit: 'no summary',
      results: 3,
      files: [other],
      blocking: true,
      remedy: 're-run the failed jobs',
    },
  ]);
  assert.deepEqual(out.suites.removed, []);
  assert.deepEqual(
    out.suites.unrun.map((u) => u.test),
    [`${other} :: w2`]
  );
  assert.equal(out.suites.same, 1);
  assert.deepEqual(releaseEvidence(out.findings), {
    files: [other],
    named: `1 files without results: ${other}`,
    remedy: 're-run the failed jobs',
  });
  assert.equal(
    releaseEvidence([{ kind: 'missing-evidence', what: 'the release suite', blocking: true }])
      .named,
    'no results'
  );
  assert.equal(
    releaseEvidence([
      {
        kind: 'missing-evidence',
        what: 'the release suite',
        blocking: true,
        results: 1,
        exit: 'signal SIGTERM',
      },
    ]).named,
    '1 results, exit signal SIGTERM'
  );
  assert.equal(releaseEvidence([]), undefined);
});

test("a test title built from a template literal matches the rows it ran as, so #731's fork-tls rows are judged, not not-run (#742)", async () => {
  const forktls = await readFile(new URL('fork-tls.test.mjs', import.meta.url), 'utf8');
  const patch = `@@ -0,0 +1,${forktls.split('\n').length} @@\n${forktls
    .split('\n')
    .map((l) => `+${l}`)
    .join('\n')}`;
  const row = rowOf({ number: 731, title: 'fix: a forked WASIX child reads errno (#728)' }, [
    { filename: 'test/integration/fork-tls.test.mjs', status: 'added', patch },
  ]);
  const template =
    'a forked child of a \u2026 WASIX program reads errno and its thread-locals, in both TLS models (#728)';
  const side =
    'a forked child of a WASIX program reads the thread-locals of a side module its parent loaded (#728)';
  assert.deepEqual(row.tests[0].titles, [template, side]);
  const f = 'test/integration/fork-tls.test.mjs';
  const named = (kind) =>
    `a forked child of a ${kind} WASIX program reads errno and its thread-locals, in both TLS models (#728)`;
  const prev = resultsMap([
    res(f, named('pie'), 'fail'),
    res(f, named('static'), 'fail'),
    res(f, side, 'pass'),
  ]);
  const next = resultsMap([
    res(f, named('pie'), 'pass'),
    res(f, named('static'), 'pass'),
    res(f, side, 'pass'),
  ]);
  const decided = decide(row, prev, next);
  assert.deepEqual(decided.checks, [
    { file: f, title: template, next: 'pass', prev: 'fail' },
    { file: f, title: side, next: 'pass', prev: 'pass' },
  ]);
  assert.equal(decided.decision, 'negative');
  const onlySide = decide(
    row,
    resultsMap([res(f, side, 'fail')]),
    resultsMap([res(f, side, 'pass')])
  );
  assert.deepEqual(onlySide.checks[0], {
    file: f,
    title: template,
    next: 'missing',
    prev: 'missing',
  });
  assert.deepEqual(titlesFromPatch('+test(`${a}${b}`, () => {});'), []);
});

test('an incomplete release suite is INCOMPLETE with an error status, never certified and not FAIL, unless code found a real defect', () => {
  const base = {
    name: '@ai-ecoverse/slicc-kernel',
    version: '1.2.3',
    ci: 'ci: run',
    certified: 'certified x',
  };
  const incomplete = {
    files: ['test/integration/a.test.mjs'],
    named: '1 files without results: test/integration/a.test.mjs',
    remedy: 're-run the failed jobs',
  };
  assert.deepEqual(verdictLine({ ...base, problems: [], review: { verdict: 'certified' } }), {
    state: 'success',
    line: 'certified x',
  });
  for (const verdict of ['certified', 'fail']) {
    assert.deepEqual(
      verdictLine({
        ...base,
        problems: [],
        review: { verdict, reason: 'missing tests' },
        incomplete,
      }),
      {
        state: 'error',
        line: 'cert-ci: INCOMPLETE @ai-ecoverse/slicc-kernel@1.2.3 (1 files without results: test/integration/a.test.mjs; re-run the failed jobs) (ci: run)',
      }
    );
  }
  const failed = verdictLine({
    ...base,
    problems: ['kernel-compat: x crashes again'],
    review: { verdict: 'certified' },
    incomplete,
  });
  assert.equal(failed.state, 'failure');
  assert.match(
    failed.line,
    /^cert-ci: FAIL .*kernel-compat: x crashes again; the release suite is incomplete/
  );
  assert.deepEqual(
    unfinishedFiles(
      ['a', 'b', 'c'],
      [res('a', 'x', 'pass'), res('b', 'b', 'fail'), res('d', 'y', 'cancelled')]
    ),
    ['b', 'c', 'd']
  );
});

test('the suite runner re-runs once the files that left no result and merges them, for the release and for a NEGATIVE run (#748)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-retry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tree = join(dir, 'tree');
  await mkdir(join(tree, 'test/integration'), { recursive: true });
  await mkdir(join(dir, 'package/dist'), { recursive: true });
  await writeFile(join(dir, 'package/dist/node.js'), 'export {};\n');
  execFileSync('tar', ['-czf', join(dir, 'k.tgz'), '-C', dir, 'package']);
  await writeFile(
    join(tree, 'package.json'),
    JSON.stringify({ scripts: { test: "node --test 'test/integration/*.test.mjs'" } })
  );
  const flaky = (marker) =>
    `import { existsSync, writeFileSync } from 'node:fs';\nimport { test } from 'node:test';\ntest('before', () => {});\ntest('the runner is lost', () => { if (!existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, ''); process.kill(process.pid, 'SIGKILL'); } });\ntest('after', () => {});\n`;
  await writeFile(join(tree, 'test/integration/a.test.mjs'), flaky(join(dir, 'a.marker')));
  await writeFile(
    join(tree, 'test/integration/b.test.mjs'),
    "import { test } from 'node:test';\ntest('steady', () => {});\n"
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const suite = (out, files = []) =>
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('suite.mjs', tools)),
        '--tree',
        tree,
        '--tgz',
        join(dir, 'k.tgz'),
        '--out',
        out,
        ...(files.length ? ['--files', files.join(',')] : []),
      ],
      { env, stdio: 'ignore' }
    );
  suite(join(dir, 'out/release'));
  const release = JSON.parse(await readFile(join(dir, 'out/release.json'), 'utf8'));
  assert.deepEqual(
    [release.exit, release.firstExit, release.retried, release.unfinished],
    [0, 1, ['test/integration/a.test.mjs'], []]
  );
  assert.deepEqual(
    release.results.map((r) => `${r.file.split('/').pop()} ${r.name} ${r.status}`).sort(),
    [
      'a.test.mjs after pass',
      'a.test.mjs before pass',
      'a.test.mjs the runner is lost pass',
      'b.test.mjs steady pass',
    ]
  );
  assert.match(
    await readFile(join(dir, 'out/release.log'), 'utf8'),
    /retrying 1 files without results/
  );
  await writeFile(
    join(dir, 'delta.json'),
    JSON.stringify({ prev: '1.2.2', version: '1.2.3', rows: [], files: [] })
  );
  await writeFile(join(dir, 'base.json'), JSON.stringify({ exit: 0, results: release.results }));
  execFileSync(process.execPath, [
    fileURLToPath(new URL('findings.mjs', tools)),
    '--delta',
    join(dir, 'delta.json'),
    '--prev',
    join(dir, 'out/none.json'),
    '--release',
    join(dir, 'out/release.json'),
    '--base',
    join(dir, 'base.json'),
    '--out',
    join(dir, 'findings.json'),
  ]);
  const found = JSON.parse(await readFile(join(dir, 'findings.json'), 'utf8')).findings;
  assert.deepEqual(
    found.filter((f) => f.what === 'the release suite'),
    []
  );
  assert.equal(releaseEvidence(found), undefined);
  await rm(join(dir, 'a.marker'));
  suite(join(dir, 'out/prev'), ['test/integration/a.test.mjs']);
  const negative = JSON.parse(await readFile(join(dir, 'out/prev.json'), 'utf8'));
  assert.deepEqual(
    [negative.exit, negative.retried, negative.unfinished],
    [0, ['test/integration/a.test.mjs'], []]
  );
  assert.deepEqual(unfinishedFiles(negative.expected, negative.results), []);
});

test('a compat rerun tests exactly the package@version that regressed, and one that ran another version is a rerun-mismatch, reproduced, never a flake (#765)', () => {
  const row = (version, spec, verdict) => ({
    package: '@ai-ecoverse/wasix-python',
    recipe: 'wasix-python',
    version,
    spec,
    users: 'off',
    verdict,
    error: verdict === 'regression' ? 'epoll row failed' : '',
    reference: { status: 'pass' },
  });
  const report = {
    results: [row('3.14.2-18', 'epoll.mjs', 'regression'), row('3.14.2-18', 'ok.mjs', 'pass')],
  };
  const regressions = compatRegressions(report);
  assert.equal(rerunSet(regressions), 'wasix-python@3.14.2-18');
  assert.equal(
    rerunSet([...regressions, { recipe: 'wasm-bash', version: '5.3-9' }, regressions[0]]),
    'wasix-python@3.14.2-18,wasm-bash@5.3-9'
  );
  const other = compatRegressions(report, { results: [row('3.14.2-21', 'epoll.mjs', 'pass')] });
  assert.deepEqual(
    other.map(({ rerun, rerunVersion, reproduced }) => ({ rerun, rerunVersion, reproduced })),
    [{ rerun: 'rerun-mismatch', rerunVersion: '3.14.2-21', reproduced: true }]
  );
  assert.deepEqual(
    compatFindingsOf({ found: true, conclusion: 'failure', regressions: other }).map((f) => [
      f.kind,
      f.package,
      f.rerun,
    ]),
    [['compat-regression', 'wasix-python@3.14.2-18', 'rerun-mismatch']]
  );
  const compatSource = readFileSync(fileURLToPath(new URL('compat.mjs', tools)), 'utf8');
  assert.match(compatSource, /const set = rerunSet\(regressions\);/);
  assert.match(compatSource, /ran: \[/);
  const same = compatRegressions(report, { results: [row('3.14.2-18', 'epoll.mjs', 'pass')] });
  assert.deepEqual(
    same.map(({ rerun, reproduced }) => [rerun, reproduced]),
    [['pass', false]]
  );
});

test('a job downstream of a job skipped by design in one mode has an explicit if, so the implicit success() never skips it', async () => {
  for (const file of ['cert-review.yml', 'release.yml']) {
    const jobs = jobsOf(await workflowText(file));
    const needs = {};
    for (const [name, body] of Object.entries(jobs)) {
      const m = /^ {4}needs: (?:\[([^\]]*)\]|(\S+))$/m.exec(body);
      needs[name] = m ? (m[1] ?? m[2]).split(',').map((x) => x.trim()) : [];
    }
    const sometimesSkipped = Object.entries(jobs)
      .filter(([, body]) => /^ {4}if: [^\n]*outputs\.mode == /m.test(body))
      .map(([name]) => name);
    const upstream = (name, seen = new Set()) => {
      for (const n of needs[name] ?? []) if (!seen.has(n)) upstream(n, seen.add(n));
      return seen;
    };
    for (const name of Object.keys(jobs)) {
      if (!sometimesSkipped.some((s) => upstream(name).has(s))) continue;
      assert.match(
        jobs[name],
        /^ {4}if: (\$\{\{ |>-\n\s+)!cancelled\(\)/m,
        `${file}: ${name} needs an explicit !cancelled() if`
      );
    }
  }
  const review = jobsOf(await workflowText('cert-review.yml'));
  assert.match(review.suite, /needs\.tarball\.result == 'success'/);
  assert.match(review.compat, /needs\.tarball\.result == 'success'/);
});

test('an INCOMPLETE Release run gets exactly one automatic re-run of its failed jobs, never one that would cancel a waiting run', async () => {
  assert.deepEqual(retryDecision({ attempt: 1, state: 'error', active: 0 }).retry, true);
  assert.deepEqual(retryDecision({ attempt: '1', state: 'error', active: 0 }).retry, true);
  assert.equal(retryDecision({ attempt: 2, state: 'error', active: 0 }).retry, false);
  assert.equal(retryDecision({ attempt: 1, state: 'failure', active: 0 }).retry, false);
  assert.equal(retryDecision({ attempt: 1, state: 'success', active: 0 }).retry, false);
  assert.equal(retryDecision({ attempt: 1, state: undefined, active: 0 }).retry, false);
  assert.match(retryDecision({ attempt: 1, state: 'error', active: 1 }).why, /would cancel one/);
  const retry = await workflowText('release-retry.yml');
  assert.match(
    retry,
    /^on:\n {2}workflow_run:\n {4}workflows: \[Release\]\n {4}types: \[completed\]$/m
  );
  assert.match(retry, /github\.event\.workflow_run\.run_attempt == 1/);
  assert.match(retry, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(retry, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(
    retry,
    /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/
  );
  assert.doesNotMatch(retry, /secrets\.|id-token|contents: write/);
  assert.match(retry, /retry\.mjs .*--attempt "\$ATTEMPT"/);
  const tool = await readFile(new URL('retry.mjs', tools), 'utf8');
  assert.match(tool, /rerun-failed-jobs/);
  assert.match(tool, /'queued', 'in_progress', 'waiting', 'requested', 'pending'/);
});

test('retry.mjs decides from the cert-review status on the run commit alone, so a tag it never listed still gets its retry', async (t) => {
  const { createServer } = await import('node:http');
  const seen = [];
  let state = 'error';
  let waiting = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/statuses'))
      return res.end(
        JSON.stringify([
          { context: 'ci / test', state: 'success' },
          ...(state ? [{ context: 'cert-review', state }] : []),
        ])
      );
    if (req.url.includes('/actions/workflows/release.yml/runs'))
      return res.end(
        JSON.stringify({ workflow_runs: req.url.includes('status=queued') ? waiting : [] })
      );
    if (req.method === 'POST' && req.url.endsWith('/rerun-failed-jobs')) {
      res.statusCode = 201;
      return res.end('{}');
    }
    res.statusCode = 404;
    return res.end('{}');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const api = `http://127.0.0.1:${server.address().port}`;
  const retry = (attempt = '1') =>
    new Promise((done) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('retry.mjs', tools)),
          '--repo',
          'o/r',
          '--run',
          '42',
          '--attempt',
          attempt,
          '--sha',
          'a'.repeat(40),
        ],
        { env: { ...process.env, GITHUB_API_URL: api, GH_TOKEN: 'x', GITHUB_STEP_SUMMARY: '' } }
      );
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.on('close', (code) => done({ code, out }));
    });
  const posts = () => seen.filter((x) => x.startsWith('POST'));
  const first = await retry();
  assert.equal(first.code, 0, first.out);
  assert.deepEqual(posts(), ['POST /repos/o/r/actions/runs/42/rerun-failed-jobs']);
  assert.ok(!seen.some((x) => x.includes('matching-refs')), 'no tag lookup');
  seen.length = 0;
  assert.equal((await retry('2')).code, 0);
  assert.deepEqual(posts(), []);
  state = 'failure';
  seen.length = 0;
  await retry();
  assert.deepEqual(posts(), []);
  state = undefined;
  seen.length = 0;
  await retry();
  assert.deepEqual(posts(), []);
  state = 'error';
  waiting = [{ id: 43 }];
  seen.length = 0;
  const blocked = await retry();
  assert.deepEqual(posts(), []);
  assert.match(blocked.out, /1 newer Release run\(s\) waiting or running/);
});
