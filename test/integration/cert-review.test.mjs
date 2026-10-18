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
  knownAsOf,
  knownLine,
  mergedPrs,
  missingShards,
  negativeEvidence,
  parseResults,
  pickRelease,
  provenanceProblems,
  releaseEvidence,
  rerunSet,
  resultsMap,
  rowOf,
  testCommand,
  titlesFromPatch,
  unfinishedFiles,
  unquote,
  verdictLine,
  versionsOnly,
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
  assert.match(String(run('base.json')), /^findings: PASS \d+ findings in /m);
  const found = JSON.parse(await readFile(join(dir, 'findings.json'), 'utf8'));
  assert.deepEqual(
    found.rows.map((r) => [r.pr, r.decision]),
    [
      [12, 'negative'],
      [7, 'negative'],
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
    '1.0.2': ['test/integration/e.test.mjs', 'test/integration/f.test.mjs'],
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
    ['#712 no-negative', '#714 no-test']
  );
  assert.deepEqual(gapsOf(undefined), []);
  assert.deepEqual(
    negativeEvidence([
      { kind: 'prev-not-run', pr: 9 },
      { kind: 'no-test', pr: 714 },
    ]),
    {
      files: [],
      named: "#9 changes shipped paths, and its tests' NEGATIVE on the previous tree has no result",
      remedy: 're-run the failed jobs',
    }
  );
  assert.equal(negativeEvidence([{ kind: 'no-negative', pr: 712 }]), undefined);
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
  const cert = await read('cert-review-pr.yml');
  const compat = await read('kernel-compat.yml');
  assert.match(
    cert,
    /LATEST: \$\{\{ needs\.plan\.outputs\.latest \}\}\n[\s\S]*?--reference "\$LATEST"/
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
  assert.match(tool, /finished\(\{ deadline \}\)/);
  assert.match(tool, /jobs\.find\(\(j\) => j\.name === 'candidate'\)/);
  assert.match(compat, /^ {2}candidate:\n/m);
  assert.doesNotMatch(compat, /^ {2}workflow_run:/m);
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
    { env, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  let said = '';
  suite.stdout.on('data', (d) => {
    said += d;
  });
  const exited = new Promise((r) => suite.once('close', (c, s) => r([c, s])));
  for (let i = 0; i < 200; i++) {
    const partial = await readFile(`${out}.jsonl`, 'utf8').catch(() => '');
    if (partial.includes('done first')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  suite.kill('SIGTERM');
  assert.deepEqual(await exited, [143, null]);
  assert.match(said, /^suite: FAIL exit signal SIGTERM, pass 1, /m);
  assert.doesNotMatch(
    said,
    /first ran/,
    "the tests' own output goes to the log, never to suite's stdout, where the gate reads the verdict"
  );
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
    { filename: 'src/process/wasi/wasi-fork.ts', status: 'modified', patch: '+x' },
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
        line: 'cert-ci: INCOMPLETE @ai-ecoverse/slicc-kernel@1.2.3 (1 files without results: test/integration/a.test.mjs; re-run the failed jobs) (ci: run; known: none)',
      }
    );
  }
  assert.equal(
    verdictLine({
      ...base,
      problems: [],
      review: { verdict: 'certified' },
      incomplete: {
        named: 'kernel-compat failure with no regression',
        remedy: 're-run the failed jobs',
      },
      known: ['ai-ecoverse/homescoop#600'],
    }).line,
    'cert-ci: INCOMPLETE @ai-ecoverse/slicc-kernel@1.2.3 (kernel-compat failure with no regression; re-run the failed jobs) (ci: run; known: ai-ecoverse/homescoop#600)'
  );
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

test('a pull request is behaviour by the paths it changes, not its title: an "A2 …" PR on src/ with a test gets its NEGATIVE, a docs-only one stays not behaviour, and a missing NEGATIVE is INCOMPLETE (#1036, #1041)', () => {
  const net = rowOf({ number: 1041, title: 'A2 net: sockets keep their peer' }, [
    { filename: 'src/kernel/net/socket.ts', status: 'modified', patch: '+x' },
    { filename: 'src/process/js/js-net.ts', status: 'modified', patch: '+x' },
    {
      filename: 'test/integration/net.test.mjs',
      status: 'modified',
      patch: "+test('a socket keeps its peer', () => {});",
    },
  ]);
  const docs = rowOf({ number: 1050, title: 'fix(docs): the README names the right flag' }, [
    { filename: 'README.md', status: 'modified', patch: '+x' },
    {
      filename: 'test/integration/docs.test.mjs',
      status: 'modified',
      patch: "+test('docs only', () => {});",
    },
  ]);
  assert.deepEqual(
    [net.kind, net.behaviour, docs.kind, docs.behaviour],
    ['other', true, 'fix', false]
  );
  assert.deepEqual(deltaFiles([net, docs]), ['test/integration/net.test.mjs']);
  const placed = withBaselines([net, docs], { commits: [], tags: [], prev: '1.124.9' });
  assert.deepEqual(baselineFiles(placed, '1.124.9'), {
    '1.124.9': ['test/integration/net.test.mjs'],
  });
  const f = 'test/integration/net.test.mjs';
  const next = resultsMap([res(f, 'a socket keeps its peer', 'pass')]);
  assert.equal(
    decide(net, resultsMap([res(f, 'a socket keeps its peer', 'fail')]), next).decision,
    'negative'
  );
  assert.equal(
    decide(net, resultsMap([res(f, 'a socket keeps its peer', 'pass')]), next).decision,
    'passes'
  );
  assert.equal(decide(net, resultsMap([]), next).decision, 'prev-not-run');
  assert.equal(
    decide(
      docs,
      resultsMap([]),
      resultsMap([res('test/integration/docs.test.mjs', 'docs only', 'pass')])
    ).decision,
    'not-behaviour'
  );
  assert.match(
    negativeEvidence([{ kind: 'prev-not-run', pr: 1041 }]).named,
    /^#1041 changes shipped paths/
  );
});

test('a pull request that only moves dependency versions in package.json and its lock is decided "manifest", no gap, because its required PR cert settled it; a scripts or exports change stays behaviour with no-test', () => {
  const pkg = (o) =>
    JSON.stringify(
      { name: 'k', version: '0.0.0', scripts: { build: 'node b.mjs' }, ...o },
      null,
      2
    );
  const deps = {
    dependencies: { a: '1.0.0' },
    devDependencies: { b: '2.0.0' },
    optionalDependencies: { c: '3.0.0' },
  };
  const bumped = {
    dependencies: { a: '1.0.1' },
    devDependencies: { b: '2.1.0' },
    optionalDependencies: { c: '3.0.1' },
  };
  assert.equal(versionsOnly(pkg(deps), pkg(bumped)), true);
  assert.equal(
    versionsOnly(pkg(deps), pkg({ ...bumped, scripts: { build: 'node c.mjs' } })),
    false,
    'a scripts change'
  );
  assert.equal(
    versionsOnly(pkg(deps), pkg({ ...bumped, exports: './x.js' })),
    false,
    'an exports change'
  );
  assert.equal(
    versionsOnly(pkg(deps), pkg({ ...bumped, dependencies: { a: '1.0.1', d: '1.0.0' } })),
    false,
    'a new dependency'
  );
  assert.equal(versionsOnly('{', pkg(deps)), false);
  const files = [
    { filename: 'package.json', status: 'modified', patch: '+x' },
    { filename: 'package-lock.json', status: 'modified', patch: '+x' },
  ];
  const bump = rowOf(
    { number: 1043, title: 'chore(deps): update dependency @ai-ecoverse/wasi-pnpm to v12.9.1-10' },
    files,
    { manifest: true }
  );
  const scripts = rowOf({ number: 1044, title: 'chore: build with c.mjs' }, files, {
    manifest: false,
  });
  const sneaky = rowOf(
    { number: 1045, title: 'chore(deps): bump' },
    [...files, { filename: 'src/x.ts', status: 'modified', patch: '+x' }],
    { manifest: true }
  );
  const none = resultsMap([]);
  assert.deepEqual(
    [bump, scripts, sneaky].map((r) => [r.behaviour, r.manifest, decide(r, none, none).decision]),
    [
      [true, true, 'manifest'],
      [true, false, 'no-test'],
      [true, false, 'no-test'],
    ]
  );
  assert.deepEqual(
    gapsOf([
      { kind: 'manifest', pr: 1043 },
      { kind: 'no-test', pr: 1044 },
    ]),
    ['#1044 no-test']
  );
});
