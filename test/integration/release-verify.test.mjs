import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as lib from '../../tools/cert-review/lib.mjs';

const { covers, releaseNotes } = lib;

const sha = 'f59beab296b367cf84c28d0343d656b12fe9d3ebdc5045d0106376bd904c3f68';
const line = (s = sha) =>
  `certified @ai-ecoverse/slicc-kernel@1.110.1 sha256=${s} (covers 1.110.1; ci: https://x/runs/1; pr-certified: #872 certified at 97ef8cf3abcd; known: none)`;

test('the certified line covers every version since the last one npm serves, so a version release-recover skipped is covered by the next', () => {
  const tags = ['v1.103.4', 'v1.104.0', 'v1.105.0', 'v1.105.1', 'v1.106.0', 'v1.110.0', 'v1.110.1'];
  assert.equal(covers('1.110.1', tags, ['1.103.4', '1.106.0', '1.110.0', '1.110.1']), '1.110.1');
  assert.equal(covers('1.106.0', tags, ['1.103.4', '1.106.0']), '1.104.0–1.106.0');
  assert.equal(covers('1.0.0', ['v1.0.0'], []), '1.0.0');
});

test('a pull request counts as certified by its cert-review at merge time: the newest finished verdict at or before the merge; a re-review still pending at the merge, or one that ends after it, changes nothing (#928)', () => {
  assert.equal(typeof lib.statusAt, 'function', 'lib.mjs picks the status at merge time');
  const { statusAt } = lib;
  const st = (state, created_at, context = 'cert-review') => ({ state, created_at, context });
  const merged = '2026-10-17T02:15:10Z';
  const at928 = [
    st('pending', '2026-10-17T02:08:19Z'),
    st('success', '2026-10-17T02:04:08Z'),
    st('pending', '2026-10-17T01:30:31Z'),
    st('failure', '2026-10-17T01:30:09Z'),
  ];
  assert.equal(statusAt(at928, ['cert-review'], merged).state, 'success');
  assert.equal(statusAt(at928.slice(2), ['cert-review'], merged).state, 'failure');
  assert.equal(statusAt(at928.slice(2, 3), ['cert-review'], merged).state, 'pending');
  const failedAgain = [st('failure', '2026-10-17T02:10:00Z'), ...at928];
  assert.equal(statusAt(failedAgain, ['cert-review'], merged).state, 'failure');
  const finished = [st('success', '2026-10-17T02:04:08Z'), st('pending', '2026-10-17T01:30:31Z')];
  assert.equal(statusAt(finished, ['cert-review'], merged).state, 'success');
  const late = [st('failure', '2026-10-17T02:40:00Z'), ...finished];
  assert.equal(statusAt(late, ['cert-review'], merged).state, 'success');
  assert.equal(statusAt([...finished].reverse(), ['cert-review'], merged).state, 'success');
  assert.equal(statusAt(late, ['cert-review'], undefined).state, 'failure');
  const old = [st('success', '2026-10-01T00:00:00Z', 'cert-review-pr')];
  assert.equal(statusAt(old, ['cert-review', 'cert-review-pr'], merged).context, 'cert-review-pr');
  assert.equal(
    statusAt([st('success', '2026-10-18T00:00:00Z')], ['cert-review'], merged),
    undefined
  );
});

test("the verify job writes homescoop's certified line into the release notes once: an identical line is left alone, another sha is a supply-chain alert", () => {
  const interim = `## Changes\n\n<!-- cert-review -->\nreport\ncertified @ai-ecoverse/slicc-kernel@1.110.1 sha256=${sha} (covers 1.108.5–1.110.1; ci: y)\n<!-- /cert-review -->\n`;
  assert.deepEqual(releaseNotes(interim, line(), { version: '1.110.1', sha256: sha }), {
    unchanged: true,
    body: interim,
  });
  const plain = '## Changes\n\n* fix: something\n';
  const written = releaseNotes(plain, line(), { version: '1.110.1', sha256: sha });
  assert.equal(
    written.body,
    `${plain.trimEnd()}\n\n<!-- cert-verify -->\n${line()}\n<!-- /cert-verify -->\n`
  );
  assert.match(
    written.body,
    /^certified @ai-ecoverse\/slicc-kernel@1\.110\.1 sha256=[0-9a-f]{64} /m
  );
  assert.equal(
    releaseNotes(written.body, line(), { version: '1.110.1', sha256: sha }).unchanged,
    true
  );
  const other = 'a'.repeat(64);
  assert.deepEqual(releaseNotes(written.body, line(other), { version: '1.110.1', sha256: other }), {
    conflict: `the release notes already certify sha256=${sha}`,
  });
  assert.equal(
    releaseNotes('', line(), { version: '1.110.1', sha256: sha }).body,
    `<!-- cert-verify -->\n${line()}\n<!-- /cert-verify -->\n`
  );
});

test('release.yml verifies each published tag on npm after publish, code only, and the post-publish cert review is gone', async () => {
  const release = await readFile(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8'
  );
  const job = /\n {2}verify:\n([\s\S]*)$/.exec(release)?.[1] ?? '';
  assert.match(job, /^ {4}name: release \/ verify on npm$/m);
  assert.match(job, /^ {4}needs: \[tag, publish\]$/m);
  assert.match(
    job,
    /^ {4}if: \$\{\{ !cancelled\(\) && github\.ref == 'refs\/heads\/main' && needs\.tag\.outputs\.tags != '' \}\}$/m
  );
  assert.match(
    job,
    /permissions:\n {6}contents: write\n {6}issues: read\n {6}pull-requests: read\n {6}statuses: read\n/
  );
  assert.doesNotMatch(job, /id-token|secrets\./);
  assert.match(
    job,
    /for tag in \$TAGS; do\n {12}tools\/cert-review\/gate\.sh verify node tools\/cert-review\/verify\.mjs --repo "\$GITHUB_REPOSITORY" --version "\$\{tag#v\}" --run "\$GITHUB_RUN_ID" --wait 3600 \|\| status=1\n/
  );
  assert.equal(
    existsSync(new URL('../../.github/workflows/cert-review.yml', import.meta.url)),
    false
  );
  const verify = await readFile(
    new URL('../../tools/cert-review/verify.mjs', import.meta.url),
    'utf8'
  );
  assert.match(verify, /certified \$\{NAME\}@\$\{version\} sha256=\$\{facts\.sha256\} \(covers /);
  assert.match(verify, /supply-chain alert: /);
});

test("release.yml's tag job is light work on the light runner, publish stays on a GitHub-hosted runner with id-token, and verify on the light runner", async () => {
  const release = await readFile(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8'
  );
  const job = (name) =>
    new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[a-z-]+:\\n|$)`).exec(release)?.[1] ?? '';
  assert.match(
    job('tag'),
    /\n {4}runs-on: \$\{\{ vars\.CERT_LIGHT_RUNNER \|\| 'ubuntu-latest' \}\}\n/
  );
  assert.match(job('publish'), /\n {4}runs-on: ubuntu-latest\n/);
  assert.match(job('publish'), /\n {6}id-token: write\n/);
  assert.match(
    job('verify'),
    /\n {4}runs-on: \$\{\{ vars\.CERT_LIGHT_RUNNER \|\| 'ubuntu-latest' \}\}\n/
  );
  assert.doesNotMatch(release, /CERT_RUNNER /);
});

test("verify waits out npm's attestations lag: a 404 that turns into 200 passes; a 404 that lasts while the packument stays still, or through the whole wait, is the supply-chain FAIL; any other status fails at once (1.125.4)", async () => {
  const { awaitAttestations } = await import('../../tools/cert-review/lib.mjs');
  const clock = { t: 0 };
  const now = () => clock.t;
  const sleep = async (ms) => {
    clock.t += ms;
  };
  const answers = (list) => {
    const queue = [...list];
    return async () => ({
      ok: queue[0] === 200,
      json: async () => ({ attestations: [] }),
      status: queue.length > 1 ? queue.shift() : queue[0],
    });
  };
  clock.t = 0;
  const lag = await awaitAttestations({
    url: 'u',
    fetch: answers([404, 404, 404, 200]),
    modified: async () => 'm1',
    servedAt: 0,
    now,
    sleep,
  });
  assert.equal(lag.res.ok, true);
  assert.equal(clock.t, 45_000, 'three 15 s retries');
  clock.t = 0;
  const missing = await awaitAttestations({
    url: 'u',
    fetch: answers([404]),
    modified: async () => 'm1',
    servedAt: 0,
    now,
    sleep,
  });
  assert.match(
    missing.problem,
    /^attestations answered 404 for 30 min after npm started serving it, and its packument stopped changing 30 min ago$/
  );
  clock.t = 0;
  let n = 0;
  const moving = await awaitAttestations({
    url: 'u',
    fetch: answers([404]),
    modified: async () => `m${n++}`,
    servedAt: 0,
    now,
    sleep,
    deadline: 3_600_000,
  });
  assert.match(
    moving.problem,
    /through the whole wait$/,
    'a packument that keeps changing waits until the budget ends'
  );
  assert.equal(clock.t, 3_600_000);
  clock.t = 0;
  const other = await awaitAttestations({
    url: 'u',
    fetch: answers([500]),
    modified: async () => 'm',
    servedAt: 0,
    now,
    sleep,
  });
  assert.deepEqual([other.problem, clock.t], ['attestations answered 500', 0]);
  clock.t = 60 * 60_000;
  const lateServe = await awaitAttestations({
    url: 'u',
    fetch: answers([404, 404, 200]),
    modified: async () => 'm',
    servedAt: clock.t,
    now,
    sleep,
  });
  assert.equal(
    lateServe.res.ok,
    true,
    'the grace runs from when npm started serving it, however long after the publish'
  );
  clock.t = 0;
  let calls = 0;
  const shaky = await awaitAttestations({
    url: 'u',
    fetch: answers([404, 404, 200]),
    modified: async () => {
      calls++;
      if (calls === 1) throw new Error('npm error code ETIMEDOUT');
      return 'm';
    },
    servedAt: 0,
    now,
    sleep,
  });
  assert.equal(shaky.res.ok, true, 'one npm view error in the wait is retried, not an alert');
  clock.t = 0;
  let urls = 0;
  const later = await awaitAttestations({
    url: async () => (++urls < 3 ? undefined : 'u'),
    fetch: answers([200]),
    modified: async () => 'm',
    servedAt: 0,
    now,
    sleep,
  });
  assert.deepEqual(
    [later.res.ok, urls, clock.t],
    [true, 3, 30_000],
    'dist.attestations that appears a little after the version is waited for'
  );
  clock.t = 0;
  const never = await awaitAttestations({
    url: async () => undefined,
    fetch: answers([200]),
    modified: async () => 'm',
    servedAt: 0,
    now,
    sleep,
  });
  assert.match(
    never.problem,
    /^no attestations on npm for 30 min after npm started serving it, and its packument stopped changing/
  );
  clock.t = 0;
  let views = 0;
  const flaky = await awaitAttestations({
    url: async () => {
      views++;
      if (views === 1) throw new Error('npm error code ETIMEDOUT');
      return 'u';
    },
    fetch: answers([200]),
    modified: async () => 'm',
    servedAt: 0,
    now,
    sleep,
  });
  assert.deepEqual(
    [flaky.res.ok, views],
    [true, 2],
    'an npm view error while looking for dist.attestations is retried'
  );
  clock.t = 0;
  let gets = 0;
  const unreachable = await awaitAttestations({
    url: 'u',
    fetch: async () => {
      gets++;
      if (gets === 1) throw new Error('fetch failed');
      return { ok: true, status: 200, json: async () => ({ attestations: [] }) };
    },
    modified: async () => 'm',
    servedAt: 0,
    now,
    sleep,
  });
  assert.equal(unreachable.res.ok, true, 'a network error on the attestations is retried');
  clock.t = 0;
  const down = await awaitAttestations({
    url: 'u',
    fetch: async () => {
      throw new Error('fetch failed');
    },
    modified: async () => 'm',
    servedAt: 0,
    now,
    sleep,
  });
  assert.match(
    down.problem,
    /^attestations unreachable \(fetch failed\) for 30 min after npm started serving it/
  );
  clock.t = 0;
  let reads = 0;
  const truncated = await awaitAttestations({
    url: 'u',
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        reads++;
        if (reads === 1) throw new Error('terminated');
        return { attestations: [{ predicateType: 'x' }] };
      },
    }),
    modified: async () => 'm',
    servedAt: 0,
    now,
    sleep,
  });
  assert.deepEqual(
    [truncated.body, reads, clock.t],
    [{ attestations: [{ predicateType: 'x' }] }, 2, 15_000],
    'a body cut off after 200 headers is read again within the wait, not an alert'
  );
  clock.t = 0;
  const garbled = await awaitAttestations({
    url: 'u',
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    }),
    modified: async () => 'm',
    servedAt: 0,
    now,
    sleep,
  });
  assert.match(
    garbled.problem,
    /^attestations unreadable \(Unexpected end of JSON input\) for 30 min/
  );
  const verify = await readFile(
    new URL('../../tools/cert-review/verify.mjs', import.meta.url),
    'utf8'
  );
  assert.match(
    verify,
    /deadline: budget/,
    "the attestations wait shares the publish wait's budget"
  );
  assert.match(verify, /not a supply-chain problem, re-run this job once it does/);
});

test('verify retries a tarball download that resets or is cut off after its 200 headers, within the wait; a non-2xx answer fails at once (#1089)', async () => {
  const { downloadTarball } = await import('../../tools/cert-review/lib.mjs');
  const clock = { t: 0 };
  const now = () => clock.t;
  const sleep = async (ms) => {
    clock.t += ms;
  };
  let n = 0;
  const flaky = await downloadTarball({
    url: 'u',
    fetch: async () => {
      n++;
      if (n === 1) throw new Error('ECONNRESET');
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          if (n === 2) throw new Error('terminated');
          return new TextEncoder().encode('tgz').buffer;
        },
      };
    },
    now,
    sleep,
  });
  assert.deepEqual([flaky.bytes?.toString(), n, clock.t], ['tgz', 3, 30_000]);
  clock.t = 0;
  const down = await downloadTarball({
    url: 'u',
    fetch: async () => {
      throw new Error('fetch failed');
    },
    now,
    sleep,
    deadline: 3_600_000,
  });
  assert.equal(down.problem, 'downloading u failed through the whole wait: fetch failed');
  assert.equal(clock.t, 3_600_000);
  clock.t = 0;
  const gone = await downloadTarball({
    url: 'u',
    fetch: async () => ({ ok: false, status: 403 }),
    now,
    sleep,
  });
  assert.deepEqual([gone.problem, clock.t], ['downloading u answered 403', 0]);
  const verify = await readFile(
    new URL('../../tools/cert-review/verify.mjs', import.meta.url),
    'utf8'
  );
  assert.match(verify, /downloadTarball\(\{ url, fetch, sleep, deadline: budget/);
});
