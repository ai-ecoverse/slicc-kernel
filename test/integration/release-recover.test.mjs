import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { recover, verdictOf } from '../../tools/release-recover.mjs';

const NAME = '@ai-ecoverse/slicc-kernel';

function fakeRun({ head = 'v1.2.3', latest = { code: 0, stdout: '1.2.2\n' } } = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    calls.push(line);
    if (line === 'git tag --points-at HEAD') return { code: 0, stdout: `${head}\n`, stderr: '' };
    if (cmd === 'git' && args[0] === 'ls-remote') return { code: 0, stdout: '', stderr: '' };
    if (cmd === 'git' && args[0] === 'show-ref') return { code: 1, stdout: '', stderr: '' };
    if (line === `npm view ${NAME}@${head.slice(1)} version --prefer-online`)
      return calls.includes('npm publish')
        ? { code: 0, stdout: `${head.slice(1)}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'npm error code E404' };
    if (line === `npm view ${NAME} dist-tags.latest --prefer-online`)
      return { stderr: '', ...latest };
    if (line.startsWith('npm view') && line.endsWith('dist.tarball --prefer-online'))
      return { code: 0, stdout: 'https://registry.npmjs.org/x.tgz\n', stderr: '' };
    if (cmd === 'npm') return { code: 0, stdout: '', stderr: '' };
    if (cmd === 'gh') return { code: 0, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${line}` };
  };
  return { run, calls };
}

const quiet = { sleep: async () => {}, log: () => {}, head: async () => true };

test("release-recover publishes a version newer than npm's latest, and never moves latest back to an older one (#837)", async () => {
  const newer = fakeRun({ head: 'v1.2.3', latest: { code: 0, stdout: '1.2.2\n' } });
  const logs = [];
  const done = await recover({ name: NAME, run: newer.run, ...quiet, log: (l) => logs.push(l) });
  assert.ok(newer.calls.includes('npm publish'), newer.calls.join('\n'));
  assert.ok(done.includes(`${NAME}@1.2.3 on npm`));

  const older = fakeRun({ head: 'v1.2.3', latest: { code: 0, stdout: '1.2.10\n' } });
  const said = [];
  await recover({ name: NAME, run: older.run, ...quiet, log: (l) => said.push(l) });
  assert.ok(!older.calls.includes('npm publish'), older.calls.join('\n'));
  assert.ok(
    said.some((l) =>
      l.includes(
        `${NAME}@1.2.3 is older than npm's latest 1.2.10: not published, so latest doesn't move back`
      )
    ),
    said.join('\n')
  );
  assert.ok(older.calls.includes('gh release view v1.2.3'), 'the GitHub release is still checked');
});

test("release-recover fails closed when npm's latest can't be read: nothing is published (#837)", async () => {
  const down = fakeRun({ latest: { code: 1, stdout: '', stderr: 'npm error code ETIMEDOUT' } });
  await assert.rejects(
    recover({ name: NAME, run: down.run, ...quiet }),
    /npm view @ai-ecoverse\/slicc-kernel dist-tags\.latest failed \(npm error code ETIMEDOUT\), so 1\.2\.3 isn't published/
  );
  assert.ok(!down.calls.includes('npm publish'));
  const empty = fakeRun({ latest: { code: 0, stdout: '\n' } });
  await assert.rejects(
    recover({ name: NAME, run: empty.run, ...quiet }),
    /npm's latest .* reads as ""/
  );
  assert.ok(!empty.calls.includes('npm publish'));
});

test("release.yml's `node tools/release-recover.mjs` does its work also from a checkout reached through a symlink, instead of exiting 0 having done nothing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'recover-link-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  await symlink(repo, join(dir, 'checkout'));
  const empty = join(dir, 'empty');
  await symlink(tmpdir(), empty);
  const run = spawnSync(process.execPath, [join(dir, 'checkout', 'tools', 'release-recover.mjs')], {
    cwd: empty,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, RELEASE_OUTCOME: 'success' },
  });
  assert.notEqual(run.status, 0, `it ran its main part: ${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /package\.json/);
  assert.match(run.stdout, /^release-recover: FAIL .*package\.json/m);
});

test('release-recover always ends with a verdict line, and release.yml fails the step when the line is missing, so a tool that silently did nothing never reads as a pass', async (t) => {
  assert.equal(verdictOf([]), 'release-recover: PASS nothing to recover');
  assert.equal(
    verdictOf(['tag v1.2.3 on origin', '@x/y@1.2.3 on npm']),
    'release-recover: PASS recovered tag v1.2.3 on origin, @x/y@1.2.3 on npm'
  );
  assert.equal(verdictOf([], new Error('boom\nmore')), 'release-recover: FAIL boom');
  const release = await readFile(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8'
  );
  const step =
    /\n {8}run: \|\n((?: {10}.*\n)*?) {10}node tools\/release-recover\.mjs \| tee "\$RUNNER_TEMP\/recover\.log"\n((?: {10}.*\n)+)/.exec(
      release
    );
  assert.ok(step, 'release.yml runs release-recover through the verdict check');
  const script = (tool) =>
    `${step[1]}${tool} | tee "$RUNNER_TEMP/recover.log"\n${step[2]}`.replace(/^ {10}/gm, '');
  const dir = await mkdtemp(join(tmpdir(), 'recover-step-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bash = (tool) =>
    spawnSync('bash', ['-c', script(tool)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, RUNNER_TEMP: dir },
    });
  const silent = bash('true');
  assert.equal(silent.status, 1, 'a guard that skipped the tool fails the step');
  assert.match(silent.stdout, /no PASS verdict from release-recover/);
  assert.equal(bash("echo 'release-recover: PASS nothing to recover'").status, 0);
  assert.notEqual(bash("echo 'release-recover: FAIL x'; exit 1").status, 0);
});
