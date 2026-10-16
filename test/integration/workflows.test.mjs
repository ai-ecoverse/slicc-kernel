import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decide } from '../../.github/runner.mjs';

const ci = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const repo = { owner: 'ai-ecoverse', repo: 'slicc-kernel' };
const env = { POOL: 'cloud-run-bench' };
const queued = (nodes) => ({
  graphql: async () => ({ repository: { mergeQueue: { entries: { nodes } } } }),
});
const run = async (context, nodes = []) =>
  (await decide({ context: { repo, ...context }, github: queued(nodes), env })).runner;
const pr = (head) => ({
  eventName: 'pull_request',
  payload: { pull_request: { head: { repo: head } } },
});
const group = {
  eventName: 'merge_group',
  payload: { merge_group: { base_ref: 'refs/heads/main', head_sha: 'b' } },
};
const entry = (position, oid, isCrossRepository) => ({
  position,
  headCommit: { oid },
  pullRequest: { number: position, isCrossRepository },
});

test('the decider gives the pool to same-repo PRs and a hosted runner to forks', async () => {
  assert.equal(await run(pr({ full_name: 'ai-ecoverse/slicc-kernel' })), 'cloud-run-bench');
  assert.equal(await run(pr({ full_name: 'someone/slicc-kernel' })), 'ubuntu-latest');
  assert.equal(await run(pr(null)), 'ubuntu-latest');
});

test('a merge group gets the pool only when it and every entry ahead of it are same-repo', async () => {
  assert.equal(await run(group, [entry(1, 'a', false), entry(2, 'b', false)]), 'cloud-run-bench');
  assert.equal(await run(group, [entry(1, 'b', false), entry(2, 'c', true)]), 'cloud-run-bench');
  assert.equal(await run(group, [entry(1, 'a', true), entry(2, 'b', false)]), 'ubuntu-latest');
  assert.equal(await run(group, [entry(1, 'b', true)]), 'ubuntu-latest');
  assert.equal(
    await run(group, [{ position: 1, headCommit: { oid: 'b' }, pullRequest: null }]),
    'ubuntu-latest'
  );
});

test('a merge group the queue does not list runs hosted', async () => {
  assert.equal(await run(group, [entry(1, 'a', false)]), 'ubuntu-latest');
  assert.equal(await run(group, []), 'ubuntu-latest');
  const missing = { graphql: async () => ({ repository: { mergeQueue: null } }) };
  const r = await decide({ context: { repo, ...group }, github: missing, env });
  assert.equal(r.runner, 'ubuntu-latest');
});

test('other events run hosted, and vars.CI_RUNNER overrides the decision', async () => {
  assert.equal(await run({ eventName: 'push', ref: 'refs/heads/main' }), 'ubuntu-latest');
  assert.equal(await run({ eventName: 'workflow_dispatch' }), 'ubuntu-latest');
  const forced = await decide({
    context: { repo, eventName: 'merge_group' },
    github: queued([]),
    env: { FORCED: 'x' },
  });
  assert.equal(forced.runner, 'x');
});

test('CI classifies a fork PR on a hosted runner and never skips the required check', () => {
  assert.match(
    ci,
    /\n {4}runs-on: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.head\.repo\.full_name != github\.repository && 'ubuntu-latest' \|\| vars\.CERT_LIGHT_RUNNER/
  );
  assert.match(ci, /sparse-checkout: \.github\/runner\.mjs\n/);
  assert.match(ci, /\.catch\(\s*\(error\) => \(\{ runner: 'ubuntu-latest'/);
  assert.match(ci, /\n {2}ci:\n {4}needs: runner\n {4}if: \$\{\{ !cancelled\(\) \}\}\n/);
  assert.match(
    ci,
    /\n {6}runs-on: \$\{\{ needs\.runner\.outputs\.runner \|\| 'ubuntu-latest' \}\}\n/
  );
});

const pick = ci
  .match(/\n {6}- id: pick\n[\s\S]*?\n {10}script: \|\n((?: {12}.*\n)+)/)[1]
  .replace(/^ {12}/gm, '');
const runPick = async (workspace) => {
  const out = {};
  const summary = {
    addRaw(s) {
      out.why = s;
      return summary;
    },
    write: async () => {},
  };
  const core = { setOutput: (k, v) => (out[k] = v), summary };
  const process = { env: { GITHUB_WORKSPACE: workspace, POOL: 'cloud-run-bench' } };
  const context = { repo, ...pr({ full_name: 'ai-ecoverse/slicc-kernel' }) };
  const AsyncFunction = (async () => {}).constructor;
  await new AsyncFunction('context', 'github', 'core', 'process', pick)(
    context,
    queued([]),
    core,
    process
  );
  return out;
};

test('CI loads the decider from the protected branch for a merge group and the base commit for a PR, never from the code under test', () => {
  assert.match(
    ci,
    /\n {10}ref: \$\{\{ github\.event\.merge_group\.base_ref \|\| github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}\n {10}sparse-checkout: \.github\/runner\.mjs\n/
  );
  assert.doesNotMatch(ci, /merge_group\.base_sha/);
});

test('the pick step uses the decider and falls back to a hosted runner when it is missing or fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runner-pick-'));
  try {
    const good = join(root, 'good');
    await mkdir(join(good, '.github'), { recursive: true });
    await writeFile(
      join(good, '.github/runner.mjs'),
      await readFile(new URL('../../.github/runner.mjs', import.meta.url))
    );
    assert.equal((await runPick(good)).runner, 'cloud-run-bench');

    const missing = await runPick(join(root, 'missing'));
    assert.equal(missing.runner, 'ubuntu-latest');
    assert.match(missing.why, /the decider failed/);

    const bad = join(root, 'bad');
    await mkdir(join(bad, '.github'), { recursive: true });
    await writeFile(
      join(bad, '.github/runner.mjs'),
      'export async function decide() { throw new Error("boom"); }\n'
    );
    const failed = await runPick(bad);
    assert.equal(failed.runner, 'ubuntu-latest');
    assert.match(failed.why, /the decider failed: boom/);

    const broken = join(root, 'broken');
    await mkdir(join(broken, '.github'), { recursive: true });
    await writeFile(join(broken, '.github/runner.mjs'), 'export const nothing = 1;\n');
    assert.equal((await runPick(broken)).runner, 'ubuntu-latest');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const compat = await readFile(
  new URL('../../.github/workflows/kernel-compat.yml', import.meta.url),
  'utf8'
);

const candidateScript = () => {
  const at = compat.indexOf('  candidate:');
  const start = compat.indexOf("node --input-type=module - <<'JS'\n", at);
  const body = compat.slice(
    compat.indexOf('\n', start) + 1,
    compat.indexOf('\n          JS\n', start)
  );
  return body.replace(/^ {10}/gm, '');
};

const runCandidate = async (env) => {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--input-type=module', '-'],
      { env: { PATH: process.env.PATH, ...env } },
      (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr })
    );
    child.stdin.end(candidateScript());
  });
};

test('kernel-compat takes a PR build x.y.z-pr.N.M from a named artifact run, for proofs of PR builds, and stays x.y.z for npm (#684)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  const root = await mkdtemp(join(tmpdir(), 'compat-candidate-'));
  try {
    const version = '1.2.3-pr.45.67';
    await mkdir(join(root, 'pkg/package'), { recursive: true });
    await writeFile(
      join(root, 'pkg/package/package.json'),
      JSON.stringify({ name: '@ai-ecoverse/slicc-kernel', version })
    );
    await mkdir(join(root, 'candidate'));
    const tgz = join(root, 'candidate/kernel.tgz');
    execFileSync('tar', ['-czf', tgz, '-C', join(root, 'pkg'), 'package']);
    const sha = createHash('sha256')
      .update(await readFile(tgz))
      .digest('hex');
    const output = join(root, 'output');
    await writeFile(output, '');
    const env = { RUNNER_TEMP: root, GITHUB_OUTPUT: output, RUN: '89', SHA256: sha };

    const pr = await runCandidate({ ...env, INPUT: version, ARTIFACT: 'kernel-tgz' });
    assert.equal(pr.ok, true, pr.stderr);
    assert.equal(
      await readFile(output, 'utf8'),
      `version=${version}\nkernel=kernel-tgz-${version}-${sha.slice(0, 12)}\n`
    );

    const npm = await runCandidate({ ...env, INPUT: version, ARTIFACT: '' });
    assert.equal(npm.ok, false);
    assert.match(npm.stderr, /version 1\.2\.3-pr\.45\.67 is not x\.y\.z\n/);

    const other = await runCandidate({ ...env, INPUT: '1.2.3-beta.1', ARTIFACT: 'kernel-tgz' });
    assert.equal(other.ok, false);
    assert.match(other.stderr, /is not x\.y\.z or x\.y\.z-pr\.N\.M/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.match(compat, /\n {4}if: .*!contains\(needs\.candidate\.outputs\.version, '-pr\.'\)/);
});
