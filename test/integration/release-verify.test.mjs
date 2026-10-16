import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { covers, releaseNotes } from '../../tools/cert-review/lib.mjs';

const sha = 'f59beab296b367cf84c28d0343d656b12fe9d3ebdc5045d0106376bd904c3f68';
const line = (s = sha) =>
  `certified @ai-ecoverse/slicc-kernel@1.110.1 sha256=${s} (covers 1.110.1; ci: https://x/runs/1; pr-certified: #872 certified at 97ef8cf3abcd; known: none)`;

test('the certified line covers every version since the last one npm serves, so a version release-recover skipped is covered by the next', () => {
  const tags = ['v1.103.4', 'v1.104.0', 'v1.105.0', 'v1.105.1', 'v1.106.0', 'v1.110.0', 'v1.110.1'];
  assert.equal(covers('1.110.1', tags, ['1.103.4', '1.106.0', '1.110.0', '1.110.1']), '1.110.1');
  assert.equal(covers('1.106.0', tags, ['1.103.4', '1.106.0']), '1.104.0–1.106.0');
  assert.equal(covers('1.0.0', ['v1.0.0'], []), '1.0.0');
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
    /for tag in \$TAGS; do\n {12}node tools\/cert-review\/verify\.mjs --repo "\$GITHUB_REPOSITORY" --version "\$\{tag#v\}" --run "\$GITHUB_RUN_ID" --wait 3600 \|\| status=1\n/
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
