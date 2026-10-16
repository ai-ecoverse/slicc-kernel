import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  behaviourFiles,
  groupVerdict,
  jobsEvidence,
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
if (a.includes('graphql')) console.log(JSON.stringify({ data: { repository: { issue: { state: 'OPEN', stateReason: null, closedAt: null, closedByPullRequestsReferences: { nodes: [] } } } } }));
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
      json: JSON.parse(await readFile(join(out, 'record.json'), 'utf8')),
    };
  };
  const good = await record(['--tarball', ok.file, '--sha256', ok.sha256]);
  assert.equal(good.status, 0, JSON.stringify(good.json.problems));
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
      ...extra,
    ]);
  const go = await plan(['--action', 'labeled', '--label', 'merge-ok', '--labels', 'merge-ok']);
  assert.match(go.out, /go=true/);
  assert.equal(statuses().at(-1).state, 'pending');
  assert.equal(statuses().at(-1).context, 'cert-review-pr');
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
          { context: 'cert-review-pr', state: 'success' },
        ];
      if (st[1] === heads[12])
        return [{ context: 'cert-review-pr', state: state12, description: 'cert-ci: INCOMPLETE' }];
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

test("the workflow: same-repo PRs with merge-ok review the merge ref with main's own tools, the key only in the review step, merge groups only look up", () => {
  assert.match(
    workflow,
    /^ {2}pull_request:\n {4}types: \[opened, synchronize, reopened, labeled\]\n {2}merge_group:\n/m
  );
  assert.match(
    workflow,
    /github\.event\.action == 'labeled' && github\.event\.label\.name != 'merge-ok' && format\('cert-review-pr-noop-\{0\}', github\.run_id\)/
  );
  assert.match(
    jobs.plan,
    /if: github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name == github\.repository/
  );
  for (const [name, body] of Object.entries(jobs)) {
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
          ? /ref: \$\{\{ github\.event\.merge_group\.base_sha \}\}$/
          : /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}$/,
        `${name} runs main's tools`
      );
  }
  for (const name of ['plan', 'pack', 'suite'])
    assert.match(jobs[name], /git fetch -q --no-tags --depth=2 origin "\$GITHUB_SHA"/);
  assert.match(jobs.plan, /echo "commit=\$GITHUB_SHA"/);
  assert.match(jobs.plan, /echo "parent=\$\(git rev-parse "\$GITHUB_SHA\^1"\)"/);
  assert.match(jobs.pack, /^ {4}runs-on: ubuntu-latest$/m);
  const secretSteps = workflow.match(/secrets\.[A-Z_]+/g) ?? [];
  assert.deepEqual(secretSteps, ['secrets.AWS_BEARER_TOKEN_BEDROCK']);
  assert.match(
    jobs.review,
    /uses: anthropics\/claude-code-action\/base-action@[0-9a-f]{40}\n {8}env:\n {10}AWS_BEARER_TOKEN_BEDROCK:/
  );
  assert.match(jobs.review, /FILING: 'off'/);
  assert.doesNotMatch(workflow, /id-token|issues: write|contents: write/);
  assert.match(jobs.group, /if: github\.event_name == 'merge_group'/);
  assert.match(jobs.group, /pr\.mjs lookup /);
  assert.doesNotMatch(jobs.group, /secrets\.|claude|suite\.mjs|compat\.mjs/);
  assert.match(
    jobs.compat,
    /--ref main --run "\$GITHUB_RUN_ID" --artifact "kernel-tgz-\$VERSION" --sha256 "\$SHA256"/
  );
  assert.match(
    jobs.record,
    /JOBS: pack=\$\{\{ needs\.pack\.result \}\},suite=\$\{\{ needs\.suite\.result \}\},kernel-compat=\$\{\{ needs\.compat\.result \}\}/
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
