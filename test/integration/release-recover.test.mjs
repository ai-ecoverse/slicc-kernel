import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recover } from '../../tools/release-recover.mjs';

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
