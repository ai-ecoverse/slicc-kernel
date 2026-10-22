import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const ci = await read('.github/workflows/ci.yml');
const pkg = JSON.parse(await read('package.json'));
const input = (name) => ci.match(new RegExp(`\\n {6}${name}: (.+)\\n`))?.[1];

test('CI is one caller of slicc-shared-web pipeline.yml, at the release of the harness the tests use', async () => {
  assert.deepEqual(await readdir(new URL('../../.github/workflows/', import.meta.url)), ['ci.yml']);
  assert.deepEqual(await readdir(new URL('../../.github/', import.meta.url)), ['workflows']);
  const version = pkg.devDependencies['@ai-ecoverse/slicc-shared-web'];
  assert.match(version, /^2\.\d+\.\d+$/);
  assert.match(
    ci,
    new RegExp(
      `\\njobs:\\n {2}ci:\\n {4}uses: ai-ecoverse/slicc-shared-web/\\.github/workflows/pipeline\\.yml@v${version.replaceAll('.', '\\.')}\\n {4}secrets: inherit\\n {4}with:\\n`
    )
  );
  assert.deepEqual(ci.split('\njobs:\n')[1].match(/^ {2}[a-z-]+:$/gm), ['  ci:']);
});

test('CI grants the pipeline the permissions its jobs ask for, attestations for the release included', () => {
  assert.match(
    ci,
    /\npermissions:\n {2}contents: write\n {2}actions: read\n {2}issues: write\n {2}pull-requests: write\n {2}statuses: write\n {2}id-token: write\n {2}attestations: write\n\n/
  );
});

test('CI runs on pull requests, merge groups and pushes to main, and cancels a superseded run only on a pull request', () => {
  assert.match(
    ci,
    /\non:\n {2}pull_request:\n {2}merge_group:\n {2}push:\n {4}branches: \[main\]\n/
  );
  assert.match(
    ci,
    /\nconcurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/
  );
  assert.doesNotMatch(ci, /workflow_dispatch|schedule:|workflow_run/);
});

test('the pipeline picks its runners and reviews no Renovate pull request, and nothing runs after a release', () => {
  for (const name of [
    'runs-on',
    'after-release',
    'review-renovate',
    'release-environment',
    'deploy',
  ]) {
    assert.equal(input(name), undefined, name);
  }
  assert.doesNotMatch(ci, /vars\./);
  assert.equal(input('shards'), '4');
  assert.equal(input('timeout-minutes'), '30');
  assert.match(input('review-prompt'), /^\|$/);
});

test('the shards split exactly the files npm test runs, on the Node the package asks for', () => {
  assert.equal(input('test'), undefined);
  assert.equal(input('test-glob'), 'test/integration/*.test.mjs');
  assert.ok(pkg.scripts.test.endsWith(` '${input('test-glob')}'`), pkg.scripts.test);
  assert.doesNotMatch(pkg.scripts.test, /NODE_OPTIONS/);
  assert.equal(input('node-version'), `'${pkg.engines.node.replace(/^>=/, '')}'`);
  assert.match(pkg.scripts.pretest, /slicc-cdp install-browser/);
  assert.equal(pkg.devDependencies['playwright-core'], undefined);
});

test('semantic-release publishes to npm from the trusted ci.yml, with provenance', async () => {
  assert.equal(pkg.fledgling.workflow, 'ci.yml');
  assert.equal(pkg.fledgling.repo, 'ai-ecoverse/slicc-kernel');
  assert.equal(pkg.publishConfig.provenance, true);
  const release = JSON.parse(await read('.releaserc.json'));
  assert.deepEqual(release.branches, ['main']);
  assert.ok(release.plugins.includes('@semantic-release/npm'));
  assert.doesNotMatch(JSON.stringify(release), /npmPublish/);
});

test('the workflow has no comments but renovate annotations', () => {
  for (const line of ci.split('\n')) {
    if (/^\s*#/.test(line)) assert.match(line, /^\s*# renovate:/);
  }
});

test('Renovate auto-merges its PRs once CI is green, except majors and updates under .github/, which open as drafts and wait for the Kernel Coordinator, and moves slicc-shared-web and its pipeline ref in one PR', async () => {
  const config = JSON.parse(await read('renovate.json'));
  assert.deepEqual(config.extends, ['github>ai-ecoverse/slicc-shared-web']);
  assert.equal(config.labels, undefined);
  assert.equal(config.automerge, true);
  assert.equal(config.platformAutomerge, true);
  const held = (match) =>
    config.packageRules.find(
      (rule) => JSON.stringify(rule).includes(match) && rule.automerge === false
    );
  assert.equal(held('"major"')?.draftPR, true);
  assert.equal(held('".github/**"')?.draftPR, true);
  assert.doesNotMatch(JSON.stringify(config), /merge-ok|cert-review|reviewer/);
  const shared = config.packageRules.find((rule) => rule.groupSlug === 'slicc-shared-web');
  assert.deepEqual(shared?.matchPackageNames, [
    '@ai-ecoverse/slicc-shared-web',
    'ai-ecoverse/slicc-shared-web',
  ]);
  assert.equal(shared.groupName, 'slicc-shared-web');
});
