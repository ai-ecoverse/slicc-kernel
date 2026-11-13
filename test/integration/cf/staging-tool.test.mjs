import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deployedOrigin,
  PREFIX,
  pullRequestOf,
  STALE_MS,
  staging,
  stagingUrl,
  staleWorkers,
  sweep,
  workerName,
} from '../../../tools/cf-staging.mjs';

test('a pull request ref names its staging Worker, and nothing else does', () => {
  assert.equal(pullRequestOf('refs/pull/1815/merge'), 1815);
  assert.equal(pullRequestOf('refs/heads/main'), undefined);
  assert.equal(pullRequestOf('gh-readonly-queue/main/pr-1815-abc'), undefined);
  assert.equal(pullRequestOf(undefined), undefined);
  assert.equal(workerName(1815), `${PREFIX}1815`);
});

test('the address comes from what wrangler deploy printed for that Worker', () => {
  const name = workerName(7);
  const printed = `Uploaded ${name} (5 sec)\n  https://${name}.some-account.workers.dev\nCurrent Version ID: x`;
  assert.equal(deployedOrigin(printed, name), `https://${name}.some-account.workers.dev`);
  assert.equal(deployedOrigin(printed, workerName(70)), undefined);
  assert.equal(stagingUrl('https://w.a.workers.dev', 'k'), 'https://w.a.workers.dev/?key=k');
});

test('only staging Workers of other pull requests, deployed longer ago than they answer, are stale', () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  const old = new Date(now - STALE_MS - 1000).toISOString();
  const fresh = new Date(now - 1000).toISOString();
  const scripts = [
    { id: `${PREFIX}1`, modified_on: old },
    { id: `${PREFIX}2`, modified_on: fresh },
    { id: `${PREFIX}3`, modified_on: old },
    { id: 'slicc-kernel-do-computer-example', modified_on: old },
    { id: 'another-worker', modified_on: old },
  ];
  assert.deepEqual(staleWorkers(scripts, `${PREFIX}3`, now), [`${PREFIX}1`]);
});

test('without a token, or outside a pull request, nothing is deployed', async () => {
  assert.match(
    (await staging({ GITHUB_REF: 'refs/pull/1/merge' })).skipped,
    /API_TOKEN is not set/
  );
  const env = { SLICC_KERNEL_CLOUDFLARE_API_TOKEN: 'x', GITHUB_REF: 'refs/heads/main' };
  assert.match((await staging(env)).skipped, /not a pull request/);
});

test('the sweep deletes every expired staging Worker through the API, and reports one it could not', async () => {
  const old = new Date(Date.now() - STALE_MS - 60_000).toISOString();
  const calls = [];
  const answer = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const call = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push(`${init.method} ${path}`);
    assert.equal(init.headers.authorization, 'Bearer t');
    if (init.method === 'GET') {
      return answer(200, {
        success: true,
        result: [
          { id: `${PREFIX}1`, modified_on: old },
          { id: `${PREFIX}2`, modified_on: old },
          { id: `${PREFIX}3`, modified_on: old },
          { id: `${PREFIX}9`, modified_on: old },
          { id: 'another-worker', modified_on: old },
        ],
      });
    }
    if (path.includes(`${PREFIX}2?`)) return answer(403, { success: false, errors: [] });
    return answer(200, { success: true, result: null });
  };
  const swept = await sweep('t', 'acct', `${PREFIX}9`, call);
  assert.deepEqual(swept.gone, [`${PREFIX}1`, `${PREFIX}3`]);
  assert.equal(swept.kept.length, 1);
  assert.match(swept.kept[0], new RegExp(`^${PREFIX}2: DELETE .*: 403$`));
  assert.deepEqual(calls, [
    'GET /client/v4/accounts/acct/workers/scripts',
    `DELETE /client/v4/accounts/acct/workers/scripts/${PREFIX}1?force=true`,
    `DELETE /client/v4/accounts/acct/workers/scripts/${PREFIX}2?force=true`,
    `DELETE /client/v4/accounts/acct/workers/scripts/${PREFIX}3?force=true`,
  ]);
});
