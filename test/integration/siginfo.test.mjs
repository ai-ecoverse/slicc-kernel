import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const fixture = new URL('./fixtures/siginfotest/', import.meta.url);

const EXPECTED = [
  'kill from a child: signo 10 code 0 pid matches uid matches status 0 size 24',
  'child exited: signo 17 code 1 pid matches uid matches status 7 size 24',
  'pthread_kill to a thread: signo 12 code -6 pid matches uid matches status 0 size 24',
  'kill of itself: signo 12 code 0 pid matches uid matches status 0 size 24',
  'child killed: signo 17 code 2 pid matches uid matches status 15 size 24',
  'alarm: signo 14 code 128 pid matches uid matches status 0 size 24',
  'a 12-byte struct: size 12 signo 12 code 0 pid left -1',
  'siginfo_take in a handler: signo 10 code 0 pid matches uid matches status 0 size 24',
  'siginfo_take with nothing pending: signo 12 code 128 pid matches uid matches status 0 size 24',
  '',
].join('\n');

for (const user of ['root', 'cone']) {
  test(`slicc.sigwait_info and slicc.siginfo_take report the sender's pid, uid and si_code, as ${user} (#892)`, {
    timeout: 60_000,
  }, async (t) => {
    const kernel = await createNodeKernel({ users: 'enforce' });
    t.after(() => kernel.terminate());
    if (user !== 'root') await kernel.users.add({ name: user });
    for (const file of ['package.json', 'bin/siginfotest.wasm']) {
      await kernel.writeFile(
        `/node_modules/siginfotest/${file}`,
        await readFile(new URL(file, fixture))
      );
    }
    assert.deepEqual(await kernel.run(['siginfotest'], { cwd: '/', user }), {
      status: 0,
      stdout: EXPECTED,
      stderr: '',
    });
  });
}

test("SIGCHLD's si_uid is the child's real uid: root's child that became a user (#892)", {
  timeout: 60_000,
}, async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  const { uid } = await kernel.users.add({ name: 'cone' });
  for (const file of ['package.json', 'bin/siginfotest.wasm']) {
    await kernel.writeFile(
      `/node_modules/siginfotest/${file}`,
      await readFile(new URL(file, fixture))
    );
  }
  assert.deepEqual(await kernel.run(['siginfotest', 'setuid', String(uid)], { cwd: '/' }), {
    status: 0,
    stdout:
      'a child that became a user exited: signo 17 code 1 pid matches uid matches status 3 size 24\n',
    stderr: '',
  });
});
