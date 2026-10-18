import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  behaviourFiles,
  decide,
  groupVerdict,
  jobsEvidence,
  REVIEWER_GLOBS,
  resultsMap,
  reviewsItself,
  withMissing,
} from '../../tools/cert-review/lib.mjs';

const tools = new URL('../../tools/cert-review/', import.meta.url);
const workflow = await readFile(
  new URL('../../.github/workflows/cert-review-pr.yml', import.meta.url),
  'utf8'
);
const jobs = (() => {
  const body = workflow.split(/^jobs:$/m)[1] ?? '';
  const out = {};
  for (const m of body.matchAll(/^ {2}([a-z-]+):\n([\s\S]*?)(?=^ {2}[a-z-]+:$|(?![\s\S]))/gm))
    out[m[1]] = m[2];
  return out;
})();

test('a pull request is reviewed when it changes shipped behaviour or the reviewer, by a conservative path filter', () => {
  const names = (list) => behaviourFiles(list.map((filename) => ({ filename })));
  assert.deepEqual(
    names([
      'src/kernel/fd-table.ts',
      'build.mjs',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      '.releaserc.json',
      'tools/release-recover.mjs',
      'tools/cert-review/lib.mjs',
      '.github/runner.mjs',
      '.github/workflows/release.yml',
      '.github/workflows/ci.yml',
      '.github/workflows/cert-review-pr.yml',
    ]).length,
    12
  );
  assert.deepEqual(
    names([
      'README.md',
      'test/integration/fd.test.mjs',
      'test/integration/fixtures/x/bin/x.wasm',
      'tools/big-file.mjs',
      '.github/workflows/kernel-compat.yml',
      'docs/x.md',
    ]),
    []
  );
  assert.deepEqual(
    behaviourFiles([{ filename: 'docs/moved.ts', previous_filename: 'src/moved.ts' }]),
    ['src/moved.ts']
  );
  assert.equal(reviewsItself([{ filename: 'tools/cert-review/record.mjs' }]), true);
  assert.equal(reviewsItself([{ filename: '.github/workflows/cert-review-pr.yml' }]), true);
  assert.equal(reviewsItself([{ filename: '.github/runner.mjs' }]), true);
  assert.equal(reviewsItself([{ filename: 'src/kernel/fd-table.ts' }]), false);
});

test('a merge group passes only when every pull request in it has a certified review of the head being merged, or changes no behaviour', () => {
  const head = (c) => c.repeat(40);
  const ok = groupVerdict([
    { pr: 1, head: head('a'), behaviour: ['src/a.ts'], state: 'success' },
    { pr: 2, head: head('b'), behaviour: [] },
  ]);
  assert.equal(ok.state, 'success');
  assert.equal(ok.line, `#1 certified at ${'a'.repeat(12)}, #2 not behaviour`);
  const bad = groupVerdict([
    { pr: 1, head: head('a'), behaviour: ['src/a.ts'], state: 'success' },
    { pr: 3, head: head('c'), behaviour: ['src/c.ts'] },
    {
      pr: 4,
      head: head('d'),
      behaviour: ['src/d.ts'],
      state: 'error',
      description: 'cert-ci: INCOMPLETE',
    },
    { pr: 5, head: head('e'), behaviour: ['src/e.ts'], state: 'failure' },
    { pr: 6, head: head('f'), behaviour: ['src/f.ts'], state: 'pending' },
  ]);
  assert.equal(bad.state, 'failure');
  assert.match(
    bad.line,
    /^not certified: #3 has no cert-review on its head c{12}; #4 has a error cert-review on its head d{12} \(cert-ci: INCOMPLETE\); #5 has a failure cert-review/
  );
  assert.match(bad.line, /#6 has a pending cert-review/);
  assert.doesNotMatch(bad.line, /#1/);
});

test('missing evidence is INCOMPLETE: a job that did not succeed, a review that left nothing, never a pass', () => {
  assert.equal(
    jobsEvidence('pack=success,suite=success,kernel-compat=success', undefined),
    undefined
  );
  const lost = jobsEvidence(
    'pack=success,suite=skipped,kernel-compat=failure,review=failure',
    undefined
  );
  assert.equal(
    lost.named,
    'the suite job ended skipped; the kernel-compat job ended failure; the review job ended failure'
  );
  assert.equal(lost.remedy, 're-run the failed jobs');
  assert.equal(
    withMissing(lost, ['no readable verdict.json']).named,
    `${lost.named}; no readable verdict.json`
  );
  assert.equal(withMissing(undefined, []), undefined);
});

const tarballOf = async (dir, manifest) => {
  const root = join(dir, `pkg-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(root, 'package'), { recursive: true });
  await writeFile(join(root, 'package', 'package.json'), JSON.stringify(manifest));
  const file = join(root, 'kernel.tgz');
  execFileSync('tar', ['-czf', file, '-C', root, 'package']);
  return {
    file,
    sha256: createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
  };
};

test("record certifies a pull request's own build by its sha256, never other bytes, and missing evidence is INCOMPLETE", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-pr-record-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
if (a.includes('graphql')) console.log(JSON.stringify({ data: { repository: { issue: { state: a.includes('n=407') ? 'CLOSED' : 'OPEN', stateReason: null, closedAt: null, closedByPullRequestsReferences: { nodes: [] } } } } }));
else if (a.includes('--slurp')) console.log('[[]]');
else if (a.includes('/compare/')) console.log(JSON.stringify({ status: 'ahead' }));
else if (a.includes('/commits/')) console.log(JSON.stringify({ commit: { committer: { date: '2026-01-01T00:00:00Z' } } }));
else process.exit(1);
`,
    { mode: 0o755 }
  );
  const version = '1.2.4-pr.9.77';
  const name = '@ai-ecoverse/slicc-kernel';
  const ok = await tarballOf(dir, { name, version });
  const other = await tarballOf(dir, { name, version: '1.2.4-pr.9.78' });
  const review = join(dir, 'review');
  await mkdir(review);
  await writeFile(
    join(review, 'verdict.json'),
    JSON.stringify({ verdict: 'certified', known: [] })
  );
  const none = join(dir, 'none');
  await mkdir(none);
  let n = 0;
  const record = async (args) => {
    const out = join(dir, `out-${n++}`);
    const run = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('record.mjs', tools)),
        '--version',
        version,
        '--review',
        review,
        '--out',
        out,
        '--commit',
        'c'.repeat(40),
        '--pr',
        '9',
        '--head',
        'd'.repeat(40),
        '--jobs',
        'pack=success,suite=success,kernel-compat=success',
        ...args,
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }
    );
    return {
      status: run.status,
      stdout: run.stdout,
      json: JSON.parse(await readFile(join(out, 'record.json'), 'utf8')),
    };
  };
  const good = await record(['--tarball', ok.file, '--sha256', ok.sha256]);
  assert.equal(good.status, 0, JSON.stringify(good.json.problems));
  assert.match(good.stdout, /^record: PASS success: certified /m);
  const planted = await record([
    '--tarball',
    ok.file,
    '--sha256',
    ok.sha256,
    '--jobs',
    'pack=success,suite=success,kernel-compat=success,artifacts=failure',
  ]);
  assert.equal(planted.status, 1);
  assert.match(planted.json.line, /^cert-ci: INCOMPLETE .*the artifacts job ended failure/);
  const unrun = join(dir, 'unrun-findings.json');
  await writeFile(
    unrun,
    JSON.stringify({
      findings: [{ kind: 'prev-not-run', pr: 1041, title: 'A2 net: sockets keep their peer' }],
    })
  );
  const noNegative = await record([
    '--tarball',
    ok.file,
    '--sha256',
    ok.sha256,
    '--findings',
    unrun,
  ]);
  assert.equal(noNegative.status, 1);
  assert.match(
    noNegative.json.line,
    /^cert-ci: INCOMPLETE .*#1041 changes shipped paths, and its tests' NEGATIVE on the previous tree has no result/
  );
  await writeFile(
    join(review, 'verdict.json'),
    JSON.stringify({
      verdict: 'certified',
      known: ['ai-ecoverse/homescoop#407', 'ai-ecoverse/homescoop#600', '#675'],
    })
  );
  const closed = await record(['--tarball', ok.file, '--sha256', ok.sha256]);
  assert.match(
    closed.json.line,
    /; known: ai-ecoverse\/homescoop#600, ai-ecoverse\/slicc-kernel#675; downstream: merge group\)$/
  );
  await writeFile(
    join(review, 'verdict.json'),
    JSON.stringify({ verdict: 'certified', known: [] })
  );
  assert.equal(good.json.state, 'success');
  assert.equal(good.json.pr, '9');
  assert.match(
    good.json.line,
    new RegExp(
      `^certified ${name} PR #9 at d{12}, build 1\\.2\\.4-pr\\.9\\.77 sha256=${ok.sha256} `
    )
  );
  const swapped = await record(['--tarball', ok.file, '--sha256', other.sha256]);
  assert.equal(swapped.json.state, 'failure');
  assert.match(swapped.json.line, /the artifact's sha256 .* is not the pack job's/);
  const wrong = await record(['--tarball', other.file, '--sha256', other.sha256]);
  assert.equal(wrong.json.state, 'failure');
  assert.match(wrong.json.line, /the artifact is @ai-ecoverse\/slicc-kernel@1\.2\.4-pr\.9\.78/);
  const lost = await record([
    '--tarball',
    ok.file,
    '--sha256',
    ok.sha256,
    '--review',
    none,
    '--review-result',
    'failure',
    '--jobs',
    'pack=success,suite=skipped,kernel-compat=success',
  ]);
  assert.equal(lost.json.state, 'error');
  assert.match(
    lost.json.line,
    /^cert-ci: INCOMPLETE @ai-ecoverse\/slicc-kernel@1\.2\.4-pr\.9\.77 \(the suite job ended skipped; the review job ended failure; no readable verdict\.json/
  );
  const nothing = await record(['--tarball', join(dir, 'gone.tgz'), '--sha256', ok.sha256]);
  assert.equal(nothing.json.state, 'error');
  assert.match(nothing.json.line, /no build artifact to review/);
});

async function fakeApi(t, routes) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      const hit = routes(req.method, req.url);
      res.setHeader('content-type', 'application/json');
      res.statusCode = hit === undefined ? 404 : 200;
      res.end(JSON.stringify(hit ?? {}));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

const pr = (api, args) =>
  new Promise((done) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('pr.mjs', tools)), ...args], {
      env: {
        ...process.env,
        GITHUB_API_URL: api,
        GH_TOKEN: 'x',
        GITHUB_OUTPUT: '',
        GITHUB_STEP_SUMMARY: '',
      },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    child.on('close', (code) => done({ code, out }));
  });

test('the plan reviews only a behaviour change with merge-ok, records a skip as not behaviour, and makes an unreviewed one red', async (t) => {
  let files = [{ filename: 'src/a.ts' }];
  const api = await fakeApi(t, (method, url) => {
    if (url.startsWith('/repos/o/r/pulls/9/files')) return files;
    if (method === 'POST' && url.startsWith('/repos/o/r/statuses/')) return {};
    return undefined;
  });
  const statuses = () => api.seen.filter((x) => x.method === 'POST').map((x) => x.body);
  const plan = (extra) =>
    pr(api.url, [
      'plan',
      '--repo',
      'o/r',
      '--pr',
      '9',
      '--head',
      'h'.repeat(40),
      '--run',
      '1',
      '--guard',
      'PASS',
      ...extra,
    ]);
  const go = await plan(['--action', 'labeled', '--label', 'merge-ok', '--labels', 'merge-ok']);
  assert.match(go.out, /go=true/);
  assert.equal(statuses().at(-1).state, 'pending');
  assert.equal(statuses().at(-1).context, 'cert-review');
  const sync = await plan(['--action', 'synchronize', '--labels', 'bug,merge-ok']);
  assert.match(sync.out, /go=true/);
  const other = await plan(['--action', 'labeled', '--label', 'bug', '--labels', 'bug,merge-ok']);
  assert.match(other.out, /go=false/);
  const before = statuses().length;
  const waiting = await plan(['--action', 'synchronize', '--labels', '']);
  assert.match(waiting.out, /go=false/);
  assert.equal(statuses().length, before + 1);
  assert.equal(statuses().at(-1).state, 'failure');
  assert.match(
    statuses().at(-1).description,
    /^waits for merge-ok to be reviewed \(changes src\/a\.ts\)/
  );
  files = [{ filename: 'README.md' }, { filename: 'test/integration/a.test.mjs' }];
  const docs = await plan(['--action', 'opened', '--labels', '']);
  assert.match(docs.out, /go=false/);
  assert.equal(statuses().at(-1).state, 'success');
  assert.equal(
    statuses().at(-1).description,
    'not behaviour: README.md, test/integration/a.test.mjs'
  );
});

test("the merge group's cert-review is a lookup: each PR's status on the head being merged, paginated, red naming the one that isn't certified", async (t) => {
  const heads = { 11: 'a'.repeat(40), 12: 'b'.repeat(40), 13: 'c'.repeat(40) };
  let state12 = 'success';
  const api = await fakeApi(t, (method, url) => {
    if (url.startsWith('/repos/o/r/compare/'))
      return {
        commits: [
          { commit: { message: 'Merge pull request #11 from o/x' } },
          { commit: { message: 'Merge pull request #12 from o/y' } },
          { commit: { message: 'Merge pull request #13 from o/z' } },
        ],
      };
    const pull = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(url);
    if (pull) return { head: { sha: heads[pull[1]] } };
    const files = /^\/repos\/o\/r\/pulls\/(\d+)\/files/.exec(url);
    if (files) return files[1] === '13' ? [{ filename: 'README.md' }] : [{ filename: 'src/x.ts' }];
    const st = /^\/repos\/o\/r\/commits\/([0-9a-f]+)\/statuses/.exec(url);
    if (st) {
      if (st[1] === heads[11])
        return [
          { context: 'ci / test', state: 'success' },
          { context: 'cert-review', state: 'success' },
        ];
      if (st[1] === heads[12])
        return [{ context: 'cert-review', state: state12, description: 'cert-ci: INCOMPLETE' }];
      return [];
    }
    if (method === 'POST' && url.startsWith('/repos/o/r/statuses/')) return {};
    return undefined;
  });
  const lookup = () =>
    pr(api.url, [
      'lookup',
      '--repo',
      'o/r',
      '--base',
      'e'.repeat(40),
      '--head',
      'f'.repeat(40),
      '--run',
      '2',
      '--guard',
      'PASS',
    ]);
  const green = await lookup();
  assert.equal(green.code, 0, green.out);
  const posted = () => api.seen.filter((x) => x.method === 'POST');
  assert.equal(posted().at(-1).url, `/repos/o/r/statuses/${'f'.repeat(40)}`);
  assert.equal(posted().at(-1).body.state, 'success');
  assert.equal(
    posted().at(-1).body.description,
    `#11 certified at ${'a'.repeat(12)}, #12 certified at ${'b'.repeat(12)}, #13 not behaviour`
  );
  state12 = 'error';
  const red = await lookup();
  assert.equal(red.code, 1);
  assert.equal(posted().at(-1).body.state, 'failure');
  assert.match(
    posted().at(-1).body.description,
    /^not certified: #12 has a error cert-review on its head b{12}/
  );
});

test("the merge group's cert-review needs the downstream smoke too: a regression or a missing result is not certified, a known bios failure or an override passes with its note (#480)", async (t) => {
  const head = 'a'.repeat(40);
  const api = await fakeApi(t, (method, url) => {
    if (url.startsWith('/repos/o/r/compare/'))
      return { commits: [{ commit: { message: 'Merge pull request #11 from o/x' } }] };
    if (/^\/repos\/o\/r\/pulls\/11$/.test(url)) return { head: { sha: head } };
    if (/^\/repos\/o\/r\/pulls\/11\/files/.test(url)) return [{ filename: 'src/x.ts' }];
    if (url.startsWith(`/repos/o/r/commits/${head}/statuses`))
      return [{ context: 'cert-review', state: 'success' }];
    if (method === 'POST' && url.startsWith('/repos/o/r/statuses/')) return {};
    return undefined;
  });
  const dir = await mkdtemp(join(tmpdir(), 'cert-downstream-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const posted = () => api.seen.filter((x) => x.method === 'POST').at(-1).body;
  const lookup = async (state, line) => {
    const file = join(dir, `${state}.json`);
    if (state !== 'missing') await writeFile(file, JSON.stringify({ state, line }));
    return pr(api.url, [
      'lookup',
      '--repo',
      'o/r',
      '--base',
      'e'.repeat(40),
      '--head',
      'f'.repeat(40),
      '--run',
      '2',
      '--guard',
      'PASS',
      '--downstream',
      file,
    ]);
  };
  const pass = await lookup('PASS', 'downstream: PASS bios c2cec127b935 sweep: 12 pass');
  assert.equal(pass.code, 0, pass.out);
  assert.equal(posted().state, 'success');
  assert.match(
    posted().description,
    /^downstream: PASS bios c2cec127b935 sweep: 12 pass; #11 certified at a{12}/
  );
  const regression = await lookup(
    'FAIL',
    'downstream: FAIL bios c2cec127b935 sweep: 1 regressions'
  );
  assert.equal(regression.code, 1);
  assert.deepEqual(
    [posted().state, posted().description],
    ['failure', 'not certified: downstream: FAIL bios c2cec127b935 sweep: 1 regressions']
  );
  const unavailable = await lookup(
    'INCOMPLETE',
    'downstream: INCOMPLETE bios: the canary left no readable result'
  );
  assert.equal(unavailable.code, 1);
  assert.equal(posted().state, 'error');
  const missing = await lookup('missing');
  assert.equal(missing.code, 1);
  assert.deepEqual(
    [posted().state, posted().description],
    ['error', 'not certified: downstream: INCOMPLETE the downstream smoke left no result']
  );
  for (const [state, line] of [
    ['NOT_JUDGED', 'downstream: not judged (bios canary failing on main) bios c2cec127b935 sweep'],
    [
      'OVERRIDDEN',
      'downstream: overridden (downstream-override on the head, by the coordinator) bios c2cec127b935',
    ],
  ]) {
    const r = await lookup(state, line);
    assert.equal(r.code, 0, `${state}: ${r.out}`);
    assert.equal(posted().state, 'success');
    assert.ok(posted().description.startsWith(line.slice(0, 60)), state);
  }
});

test("the workflow: same-repo PRs with merge-ok review the merge ref with main's own tools, the key only in the review step, merge groups only look up", () => {
  assert.match(
    workflow,
    /^ {2}pull_request:\n {4}types: \[opened, synchronize, reopened, labeled, unlabeled, ready_for_review\]\n {2}merge_group:\n/m
  );
  assert.match(
    workflow,
    /\(\(github\.event\.action == 'labeled' && github\.event\.label\.name != 'merge-ok' && github\.event\.label\.name != 'cert-review-approved'\) \|\| \(github\.event\.action == 'unlabeled' && github\.event\.label\.name != 'cert-review-approved'\) \|\| github\.event\.action == 'ready_for_review'\) && format\('cert-review-pr-noop-\{0\}', github\.run_id\)/
  );
  assert.match(
    jobs.plan,
    /needs: guard\n {4}if: \$\{\{ !cancelled\(\) && github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name == github\.repository \}\}/
  );
  for (const [name, body] of Object.entries(jobs)) {
    if (name === 'guard') continue;
    const checkouts =
      body.match(/uses: actions\/checkout@[0-9a-f]{40}\n {8}with:\n {10}ref: [^\n]+/g) ?? [];
    assert.equal(
      checkouts.length,
      (body.match(/uses: actions\/checkout@/g) ?? []).length,
      `${name}: every checkout names its ref`
    );
    for (const c of checkouts)
      assert.match(
        c,
        name === 'group'
          ? /ref: \$\{\{ github\.event\.merge_group\.base_ref \}\}$/
          : name === 'group-pack'
            ? /ref: \$\{\{ github\.event\.merge_group\.base_sha \}\}$/
            : /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/,
        `${name} runs main's tools`
      );
  }
  for (const name of ['plan', 'pack', 'pack-base', 'suite'])
    assert.match(jobs[name], /git fetch -q --no-tags --depth=2 origin "\$GITHUB_SHA"/);
  assert.match(jobs.plan, /echo "commit=\$GITHUB_SHA"/);
  assert.match(jobs.plan, /echo "parent=\$\(git rev-parse "\$GITHUB_SHA\^1"\)"/);
  assert.match(jobs.pack, /^ {4}runs-on: ubuntu-latest$/m);
  assert.match(jobs['pack-base'], /^ {4}runs-on: ubuntu-latest$/m);
  const secretSteps = workflow.match(/secrets\.[A-Z_]+/g) ?? [];
  assert.deepEqual(secretSteps, ['secrets.AWS_BEARER_TOKEN_BEDROCK']);
  assert.match(
    jobs.review,
    /uses: anthropics\/claude-code-action\/base-action@[0-9a-f]{40}\n {8}env:\n {10}AWS_BEARER_TOKEN_BEDROCK:/
  );
  assert.match(jobs.review, /FILING: 'off'/);
  assert.doesNotMatch(workflow, /id-token|contents: write/);
  for (const [name, body] of Object.entries(jobs))
    if (name !== 'group')
      assert.doesNotMatch(body, /issues: write/, `${name}: only the group's notice files issues`);
  assert.match(
    jobs.group,
    /sparse-checkout: tools\/cert-review\n/,
    "the job that can file issues runs only main's tools"
  );
  assert.match(jobs.group, /if: \$\{\{ !cancelled\(\) && github\.event_name == 'merge_group' \}\}/);
  assert.match(jobs.group, /pr\.mjs lookup /);
  assert.doesNotMatch(jobs.group, /secrets\.|claude|suite\.mjs|compat\.mjs/);
  assert.match(
    jobs.compat,
    /--ref main --run "\$GITHUB_RUN_ID" --artifact "kernel-tgz-\$VERSION" --sha256 "\$SHA256"/
  );
  assert.match(
    jobs.record,
    /JOBS: pack=\$\{\{ needs\.pack\.result \}\},pack-base=\$\{\{ needs\.pack-base\.result \}\},delta=\$\{\{ needs\.delta\.result \}\},suite=\$\{\{ needs\.suite\.result \}\},kernel-compat=\$\{\{ needs\.compat\.result \}\}/
  );
  assert.match(jobs.report, /statuses\/\$HEAD_SHA/);
  assert.match(jobs.report, /if \[ "\$state" != success \]; then .*exit 1; fi/);
  for (const name of ['suite', 'compat', 'review', 'record', 'report'])
    assert.match(
      jobs[name],
      /^ {4}if: \$\{\{ !cancelled\(\)/m,
      `${name} has an explicit !cancelled() if`
    );
  assert.doesNotMatch(workflow, /always\(\)/);
});

test('a pull request review runs kernel-compat on ten shards, and kernel-compat hands the count to homescoop', async () => {
  assert.match(jobs.compat, /--shards 10 --dispatch --rerun --wait 150/);
  const compat = await readFile(
    new URL('../../.github/workflows/kernel-compat.yml', import.meta.url),
    'utf8'
  );
  assert.match(
    compat,
    /\n {6}shards:\n {8}description: [^\n]+\n {8}type: string\n {8}default: 'auto'\n/
  );
  assert.match(compat, /\n {6}shards: \$\{\{ inputs\.shards \|\| 'auto' \}\}\n/);
  const tool = await readFile(new URL('compat.mjs', tools), 'utf8');
  assert.match(tool, /\.\.\.\(values\.shards \? \{ shards: values\.shards \} : \{\}\)/);
});

test('a change to the reviewer is reviewed only with cert-review-approved on its head, by the shared self-guard, and a push takes the approval away', async (t) => {
  const files = [{ filename: 'tools/cert-review/record.mjs' }];
  const api = await fakeApi(t, (method, url) => {
    if (url.startsWith('/repos/o/r/pulls/9/files')) return files;
    if (method === 'POST' && url.startsWith('/repos/o/r/statuses/')) return {};
    return undefined;
  });
  const statuses = () => api.seen.filter((x) => x.method === 'POST').map((x) => x.body);
  const plan = (guard, extra) =>
    pr(api.url, [
      'plan',
      '--repo',
      'o/r',
      '--pr',
      '9',
      '--head',
      'h'.repeat(40),
      '--run',
      '1',
      '--guard',
      guard,
      ...extra,
    ]);
  const unapproved = await plan('FAIL', [
    '--action',
    'labeled',
    '--label',
    'merge-ok',
    '--labels',
    'merge-ok',
  ]);
  assert.match(unapproved.out, /go=false/);
  assert.equal(statuses().at(-1).state, 'failure');
  assert.equal(
    statuses().at(-1).description,
    'reviewer change: needs coordinator review (cert-review-approved on this head)'
  );
  const approved = await plan('PASS', [
    '--action',
    'labeled',
    '--label',
    'cert-review-approved',
    '--labels',
    'merge-ok,cert-review-approved',
  ]);
  assert.match(approved.out, /go=true/);
  assert.equal(statuses().at(-1).state, 'pending');
  const pushed = await plan('FAIL', ['--action', 'synchronize', '--labels', 'merge-ok']);
  assert.match(pushed.out, /go=false/);
  assert.equal(statuses().at(-1).state, 'failure');
  assert.match(statuses().at(-1).description, /^reviewer change: needs coordinator review/);
  const unfinished = await plan('', ['--action', 'synchronize', '--labels', 'merge-ok']);
  assert.match(unfinished.out, /go=false/);
  assert.equal(statuses().at(-1).state, 'error');
  assert.equal(
    statuses().at(-1).description,
    'the certification self-guard did not finish: re-run the failed jobs'
  );
  const before = statuses().length;
  for (const extra of [
    ['--action', 'ready_for_review', '--labels', 'merge-ok'],
    ['--action', 'unlabeled', '--label', 'bug', '--labels', 'merge-ok'],
    ['--action', 'unlabeled', '--label', 'merge-ok', '--labels', ''],
  ]) {
    const quiet = await plan('PASS', extra);
    assert.match(quiet.out, /go=false/);
  }
  assert.equal(statuses().length, before);
  const removed = await plan('FAIL', [
    '--action',
    'unlabeled',
    '--label',
    'cert-review-approved',
    '--labels',
    'merge-ok',
  ]);
  assert.match(removed.out, /go=false/);
  assert.equal(statuses().at(-1).state, 'failure');
});

test('a test(...) pull request that touches src is reviewed: the filter goes by paths, never by the title or the kind', () => {
  assert.deepEqual(
    behaviourFiles([
      { filename: 'src/cron/cron.ts' },
      { filename: 'test/integration/cron.test.mjs' },
    ]),
    ['src/cron/cron.ts']
  );
  const tool = workflow + readFileSync(fileURLToPath(new URL('pr.mjs', tools)), 'utf8');
  assert.doesNotMatch(tool, /pull_request\.title|kindOf/);
});

test('a merge group with a reviewer change the self-guard did not pass is red, and the workflow runs the pinned shared guard on every pull request and group', async (t) => {
  const api = await fakeApi(t, (method, url) => {
    if (method === 'POST' && url.startsWith('/repos/o/r/statuses/')) return {};
    return undefined;
  });
  const posted = () => api.seen.filter((x) => x.method === 'POST').map((x) => x.body);
  const lookup = (guard) =>
    pr(api.url, [
      'lookup',
      '--repo',
      'o/r',
      '--base',
      'e'.repeat(40),
      '--head',
      'f'.repeat(40),
      '--run',
      '2',
      '--guard',
      guard,
    ]);
  const red = await lookup('FAIL');
  assert.equal(red.code, 1);
  assert.equal(posted().at(-1).state, 'failure');
  assert.equal(
    posted().at(-1).description,
    'not certified: a pull request in the group changes the reviewer without cert-review-approved on its head'
  );
  const lost = await lookup('INCOMPLETE');
  assert.equal(lost.code, 1);
  assert.equal(posted().at(-1).state, 'error');
  assert.match(
    jobs.guard,
    /uses: ai-ecoverse\/slicc-shared-web\/\.github\/actions\/cert-self-guard@fe97ae242f8ddcc824334cad287346d7df3f0bbb\n {8}with:\n {10}approval-label: cert-review-approved\n {10}paths: \|\n {12}\.github\/workflows\/cert\*\.yml\n {12}\.github\/workflows\/cert\*\.yaml\n {12}scripts\/cert\/\*\*\n {12}tools\/cert-review\/\*\*\n {12}\.github\/actions\/cert-self-guard\/\*\*\n {12}\.github\/runner\.mjs\n/
  );
  assert.match(jobs.guard, /continue-on-error: true/);
  assert.match(jobs.guard, /fetch-depth: 0/);
  assert.match(
    jobs.guard,
    /permissions:\n {6}contents: read\n {6}checks: read\n {6}pull-requests: write\n/
  );
  assert.match(
    jobs.group,
    /needs: \[guard, canary\]\n {4}if: \$\{\{ !cancelled\(\) && github\.event_name == 'merge_group' \}\}/
  );
  assert.match(jobs.group, /--guard "\$GUARD" --approval cert-review-approved/);
  assert.match(jobs.plan, /--guard "\$GUARD" --approval cert-review-approved/);
  for (const name of ['pack', 'delta', 'suite', 'compat', 'review', 'record', 'report'])
    assert.match(
      jobs[name],
      /needs\.plan\.outputs\.go == 'true'/,
      `${name} runs only when plan says go`
    );
});

test("the NEGATIVE runs the pull request's test/** on main's tree and build: a tools fix fails there, and a test file that fails to load is never a NEGATIVE (#861)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-negative-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  await mkdir(join(repo, 'tools'), { recursive: true });
  await mkdir(join(repo, 'test/integration/helpers'), { recursive: true });
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify({ scripts: { test: "node --test 'test/integration/*.test.mjs'" } })
  );
  await writeFile(join(repo, 'tools/recover.mjs'), 'export const skipsOlder = () => false;\n');
  await writeFile(
    join(repo, 'test/integration/helpers/fake.mjs'),
    'export const latest = "1.0.0";\n'
  );
  execFileSync('git', ['init', '-q', repo]);
  git('add', '-A');
  git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'base');
  const parent = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'tools/recover.mjs'), 'export const skipsOlder = () => true;\n');
  await writeFile(join(repo, 'tools/brand-new.mjs'), 'export const fresh = true;\n');
  await writeFile(
    join(repo, 'test/integration/helpers/fake.mjs'),
    'export const latest = "2.0.0";\n'
  );
  await writeFile(join(repo, 'test/integration/fixture.json'), '{"older":"1.5.0"}\n');
  await writeFile(
    join(repo, 'test/integration/recover.test.mjs'),
    "import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nimport { test } from 'node:test';\nimport { skipsOlder } from '../../tools/recover.mjs';\nimport { latest } from './helpers/fake.mjs';\ntest('skips a version older than latest', () => {\n  assert.equal(latest, '2.0.0');\n  assert.ok(JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url))).older);\n  assert.equal(skipsOlder(), true);\n});\n"
  );
  await writeFile(
    join(repo, 'test/integration/fresh.test.mjs'),
    "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { fresh } from '../../tools/brand-new.mjs';\ntest('the new tool is fresh', () => assert.equal(fresh, true));\n"
  );
  git('add', '-A');
  git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'fix: skip older');
  const commit = git('rev-parse', 'HEAD');
  const tree = join(dir, 'tree');
  git('worktree', 'add', '-q', '--detach', tree, parent);
  const patch = join(dir, 'tests.patch');
  await writeFile(
    patch,
    execFileSync('git', ['-C', tree, 'diff', '--binary', parent, commit, '--', 'test/'], {
      encoding: 'utf8',
    })
  );
  execFileSync('git', ['-C', tree, 'apply', patch]);
  assert.equal(
    await readFile(join(tree, 'tools/recover.mjs'), 'utf8'),
    'export const skipsOlder = () => false;\n'
  );
  await mkdir(join(dir, 'package/dist'), { recursive: true });
  await writeFile(join(dir, 'package/dist/node.js'), 'export {};\n');
  execFileSync('tar', ['-czf', join(dir, 'k.tgz'), '-C', dir, 'package']);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const files = 'test/integration/recover.test.mjs,test/integration/fresh.test.mjs';
  const out = join(dir, 'prev');
  spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('suite.mjs', tools)),
      '--tree',
      tree,
      '--tgz',
      join(dir, 'k.tgz'),
      '--files',
      files,
      '--out',
      out,
    ],
    { env, encoding: 'utf8' }
  );
  const prev = resultsMap(JSON.parse(await readFile(`${out}.json`, 'utf8')).results);
  const next = resultsMap([
    {
      file: 'test/integration/recover.test.mjs',
      name: 'skips a version older than latest',
      status: 'pass',
    },
    { file: 'test/integration/fresh.test.mjs', name: 'the new tool is fresh', status: 'pass' },
  ]);
  const row = (file, title) => ({
    pr: 9,
    title: 'fix: skip older',
    kind: 'fix',
    behaviour: true,
    tests: [{ file, titles: [title] }],
  });
  assert.equal(
    decide(
      row('test/integration/recover.test.mjs', 'skips a version older than latest'),
      prev,
      next
    ).decision,
    'negative'
  );
  assert.equal(
    decide(row('test/integration/fresh.test.mjs', 'the new tool is fresh'), prev, next).decision,
    'prev-not-run'
  );
  assert.match(
    jobs.suite,
    /if: \$\{\{ !cancelled\(\) && matrix\.which == 'base' \}\}\n {8}run: \|[\s\S]*?git -C "\$TREE" diff --binary "\$PARENT" "\$COMMIT" -- test\/ > "\$RUNNER_TEMP\/tests\.patch"\n {12}if \[ -s "\$RUNNER_TEMP\/tests\.patch" \]; then git -C "\$TREE" apply "\$RUNNER_TEMP\/tests\.patch"; fi\n {12}tools\/cert-review\/gate\.sh --evidence suite node tools\/cert-review\/suite\.mjs --tree "\$TREE" --tgz "\$RUNNER_TEMP\/tgz\/ai-ecoverse-slicc-kernel-\$PREV\.tgz"/
  );
});

test("the reviewer's paths are one list: the self-guard holds exactly what plan counts as a change to the reviewer, so the coordinator's label is never ignored", () => {
  const block = /\n {10}paths: \|\n((?: {12}[^\n]+\n)+)/.exec(jobs.guard)?.[1] ?? '';
  assert.deepEqual(
    block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    REVIEWER_GLOBS
  );
  for (const filename of [
    '.github/workflows/cert-foo.yml',
    '.github/workflows/cert-review-pr.yml',
    'scripts/cert/x.mjs',
    'tools/cert-review/lib.mjs',
    '.github/actions/cert-self-guard/action.yml',
    '.github/runner.mjs',
  ]) {
    assert.equal(reviewsItself([{ filename }]), true, filename);
    assert.deepEqual(behaviourFiles([{ filename }]), [filename], filename);
  }
  assert.equal(reviewsItself([{ filename: 'src/kernel/fd-table.ts' }]), false);
  assert.equal(reviewsItself([{ filename: '.github/workflows/release.yml' }]), false);
  assert.match(jobs.guard, /cert-self-guard@fe97ae242f8ddcc824334cad287346d7df3f0bbb\n/);
});

test('the required cert-review never waits forever: a plan or lookup that fails before its status posts an error that asks for a re-run', () => {
  assert.match(workflow, /\n {2}CERT_CONTEXT: cert-review\n/);
  assert.match(
    jobs.plan,
    /if: failure\(\) && \(steps\.plan\.outputs\.posted != 'true' \|\| steps\.plan\.outputs\.go == 'true'\)\n[\s\S]*?\\"state\\":\\"error\\",\\"context\\":\\"\$CERT_CONTEXT\\"[\s\S]*?did not finish its plan: re-run the failed jobs/
  );
  assert.match(
    jobs.group,
    /if: failure\(\) && steps\.lookup\.outputs\.posted != 'true'\n[\s\S]*?SHA: \$\{\{ github\.event\.merge_group\.head_sha \}\}[\s\S]*?did not finish its lookup: re-run the failed jobs/
  );
});

test('the merge group runs bios canary on its own tree, packed by main tools and bound by id, digest and sha256, at a pinned bios sha, and the downstream-override is the shared self-guard on every path (#480)', () => {
  const BIOS = 'c2cec127b935419049568f584093d7ef03ac0721';
  assert.match(jobs['group-pack'], /^ {4}if: github\.event_name == 'merge_group'$/m);
  assert.match(jobs['group-pack'], /^ {4}runs-on: ubuntu-latest$/m);
  assert.match(jobs['group-pack'], /git fetch -q --no-tags --depth=1 origin "\$GITHUB_SHA"/);
  assert.match(
    jobs['group-pack'],
    /gate\.sh pack node tools\/cert-review\/pack\.mjs --version "\$VERSION" --ref "\$GITHUB_SHA"/
  );
  assert.match(jobs['group-pack'], /-group\.\$GITHUB_RUN_ID/);
  assert.match(jobs['group-pack'], /package-manager-cache: false/);
  assert.match(jobs.canary, /needs: group-pack\n {4}if: github\.event_name == 'merge_group'\n/);
  assert.match(
    jobs.canary,
    new RegExp(`uses: ai-ecoverse/slicc-bios/\\.github/workflows/canary\\.yml@${BIOS}\\n`)
  );
  for (const [input, value] of [
    ['candidate-package', "'@ai-ecoverse/slicc-kernel'"],
    ['candidate-artifact', '${{ needs.group-pack.outputs.name }}'],
    ['candidate-run', '${{ github.run_id }}'],
    ['candidate-sha256', '${{ needs.group-pack.outputs.sha256 }}'],
    ['candidate-repo', '${{ github.repository }}'],
    ['candidate-artifact-id', '${{ needs.group-pack.outputs.id }}'],
    ['candidate-artifact-digest', '${{ needs.group-pack.outputs.digest }}'],
    ['shards', `'["sweep","guard","k4-link"]'`],
    ['repeat', '1'],
  ])
    assert.ok(jobs.canary.includes(`\n      ${input}: ${value}\n`), `${input}: ${value}`);
  assert.doesNotMatch(jobs.canary, /candidate-binding|secrets/, 'strict binding, no secrets');
  assert.match(jobs.canary, /permissions:\n {6}contents: read\n {6}actions: read\n/);
  assert.match(
    jobs.guard,
    /- id: override\n[^\n]*\n {8}continue-on-error: true\n {8}uses: ai-ecoverse\/slicc-shared-web\/\.github\/actions\/cert-self-guard@fe97ae242f8ddcc824334cad287346d7df3f0bbb\n {8}with:\n {10}approval-label: downstream-override\n {10}paths: '\*\*'\n/
  );
  assert.match(jobs.guard, /override: \$\{\{ steps\.override\.outputs\.status \}\}/);
  assert.match(jobs.group, /RESULT: \$\{\{ needs\.canary\.outputs\.result \}\}/);
  assert.match(jobs.group, /OVERRIDE: \$\{\{ needs\.guard\.outputs\.override \}\}/);
  assert.match(
    jobs.group,
    new RegExp(
      `gate\\.sh --evidence downstream node tools/cert-review/downstream\\.mjs [^\\n]*--override "\\$\\{OVERRIDE:-FAIL\\}" \\\\\\n {12}--bios ${BIOS} --shards sweep,guard,k4-link --out`
    )
  );
  assert.match(
    jobs.group,
    /--approval cert-review-approved --downstream "\$RUNNER_TEMP\/downstream\.json"/
  );
  assert.match(
    jobs.group,
    new RegExp(`pr\\.mjs notice [^\\n]*\\n {12}--bios ${BIOS} --downstream`)
  );
});

function stepScript(job, id) {
  const block = job
    .split('\n      - ')
    .find(
      (b) =>
        b.startsWith(`id: ${id}\n`) ||
        b.includes(`\n        id: ${id}\n`) ||
        b.includes(`name: ${id}`)
    );
  assert.ok(block, `step ${id}`);
  const lines = block.split('\n');
  const at = lines.findIndex((l) => l === '        run: |');
  return lines
    .slice(at + 1)
    .filter((l) => l.startsWith('          ') || l === '')
    .map((l) => l.slice(10))
    .join('\n');
}

test("the merge group's steps end to end: a planted regression is red, a missing result INCOMPLETE, a stale override no waiver, and a canary broken on main is not judged, files one issue, and the next passing group closes it (#480)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cert-group-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const heads = { 11: 'a'.repeat(40) };
  let issues = [];
  const nextIssue = 50;
  const api = await fakeApi(t, (method, url) => {
    if (url.startsWith('/repos/o/r/compare/'))
      return { commits: [{ commit: { message: 'Merge pull request #11 from o/x' } }] };
    if (url === '/repos/o/r/pulls/11') return { head: { sha: heads[11] } };
    if (url.startsWith('/repos/o/r/pulls/11/files')) return [{ filename: 'src/x.ts' }];
    if (url.startsWith(`/repos/o/r/commits/${heads[11]}/statuses`))
      return [{ context: 'cert-review', state: 'success' }];
    if (method === 'POST' && url.startsWith('/repos/o/r/statuses/')) return {};
    if (method === 'GET' && url.startsWith('/repos/o/r/issues?'))
      return issues.filter((i) => i.state === 'open');
    if (method === 'POST' && url === '/repos/o/r/issues') return { number: nextIssue };
    if (method === 'POST' && /^\/repos\/o\/r\/issues\/\d+\/comments$/.test(url)) return {};
    if (method === 'PATCH' && /^\/repos\/o\/r\/issues\/\d+$/.test(url)) return {};
    return undefined;
  });
  const BIOS = 'c2cec127b935419049568f584093d7ef03ac0721';
  const canary = (o = {}) =>
    JSON.stringify({
      ok: true,
      biosRef: BIOS,
      url: 'https://github.com/o/r/actions/runs/2',
      counts: { pass: 30, skip: 0, fail: 0, regression: 0, both: 0, flaky: 0 },
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
  let n = 0;
  const group = async (result, override = 'FAIL') => {
    const temp = join(dir, `g${n++}`);
    await mkdir(temp);
    const env = {
      ...process.env,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: join(temp, 'out'),
      GITHUB_STEP_SUMMARY: join(temp, 'summary'),
      GITHUB_API_URL: api.url,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_RUN_ID: '2',
      CERT_CONTEXT: 'cert-review',
      GH_TOKEN: 'x',
      BASE_SHA: 'e'.repeat(40),
      HEAD_SHA: 'f'.repeat(40),
      GUARD: 'PASS',
      RESULT: result,
      OVERRIDE: override,
    };
    const run = (id) =>
      new Promise((done) => {
        const child = spawn('bash', ['-eo', 'pipefail', '-c', stepScript(jobs.group, id)], {
          cwd: fileURLToPath(new URL('../../', import.meta.url)),
          env,
        });
        let stdout = '';
        child.stdout.on('data', (d) => {
          stdout += d;
        });
        child.stderr.on('data', (d) => {
          stdout += d;
        });
        child.on('close', (status) => done({ status, stdout }));
      });
    const down = await run('downstream');
    const look = await run('lookup');
    const notice = down.status === 0 ? await run("bios's canary failing on main") : undefined;
    const status = api.seen
      .filter((x) => x.method === 'POST' && x.url.startsWith('/repos/o/r/statuses/'))
      .at(-1).body;
    return { down, look, notice, status };
  };
  const regression = canary({
    counts: { pass: 29, skip: 0, fail: 0, regression: 1, both: 0, flaky: 0 },
    regressions: [{ shard: 'sweep', test: 'gpg verifies', log: '' }],
  });

  const planted = await group(regression);
  assert.equal(planted.down.status, 0, planted.down.stdout);
  assert.notEqual(planted.look.status, 0);
  assert.equal(planted.status.state, 'failure');
  assert.match(
    planted.status.description,
    /^not certified: downstream: FAIL bios c2cec127b935 sweep,guard,k4-link: 1 regressions/
  );

  const missing = await group('');
  assert.notEqual(missing.look.status, 0);
  assert.equal(missing.status.state, 'error');
  assert.match(
    missing.status.description,
    /^not certified: downstream: INCOMPLETE .*the canary left no readable result/
  );

  const stale = await group(regression, 'FAIL');
  assert.equal(
    stale.status.state,
    'failure',
    'an override the guard did not bind to the head waives nothing'
  );
  const waived = await group(regression, 'PASS');
  assert.equal(waived.status.state, 'success');
  assert.match(
    waived.status.description,
    /^downstream: overridden \(downstream-override on the head, by the coordinator\)/
  );
  const unset = await group(regression, '');
  assert.equal(unset.status.state, 'failure', 'no guard output is no override');

  const broken = canary({
    counts: { pass: 0, skip: 0, fail: 0, regression: 0, both: 2, flaky: 0 },
    both: [
      { shard: 'guard', test: 'boot', log: '' },
      { shard: 'k4-link', test: 'link', log: '' },
    ],
  });
  const notJudged = await group(broken);
  assert.equal(notJudged.status.state, 'success', notJudged.look.stdout);
  assert.match(
    notJudged.status.description,
    /^downstream: not judged \(bios canary failing on main\)/
  );
  assert.equal(notJudged.notice.status, 0, notJudged.notice.stdout);
  assert.match(
    notJudged.notice.stdout,
    /::warning title=downstream::bios canary is failing on main/
  );
  const opened = api.seen.filter((x) => x.method === 'POST' && x.url === '/repos/o/r/issues');
  assert.equal(opened.length, 1);
  assert.equal(
    opened[0].body.title,
    `downstream: bios canary failing on main (${BIOS.slice(0, 12)})`
  );
  issues = [{ number: 50, state: 'open', title: opened[0].body.title }];

  const knownBoth = canary({
    counts: { pass: 28, skip: 0, fail: 0, regression: 0, both: 2, flaky: 0 },
    both: [
      { shard: 'guard', test: 'boot', log: '' },
      { shard: 'k4-link', test: 'link', log: '' },
    ],
  });
  const noted = await group(knownBoth);
  assert.equal(noted.status.state, 'success');
  assert.match(noted.status.description, /^downstream: PASS .*known downstream failures 2/);
  assert.equal(
    api.seen.filter((x) => x.method === 'POST' && x.url === '/repos/o/r/issues').length,
    1,
    'deduplicated'
  );
  assert.ok(api.seen.some((x) => x.method === 'POST' && x.url === '/repos/o/r/issues/50/comments'));
  assert.match(noted.notice.stdout, /^pr notice: PASS commented on #50/m);

  const green = await group(canary());
  assert.equal(green.status.state, 'success');
  assert.match(green.notice.stdout, /^pr notice: PASS PASS: closed #50$/m);
  assert.deepEqual(
    api.seen.filter((x) => x.method === 'PATCH').map((x) => [x.url, x.body.state]),
    [['/repos/o/r/issues/50', 'closed']]
  );
});
