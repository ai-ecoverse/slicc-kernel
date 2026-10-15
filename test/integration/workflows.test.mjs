import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
