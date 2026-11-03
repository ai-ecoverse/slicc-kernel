import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const JUDGE = 'sudo: denied by the approval judge: it looks high-risk.';

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

async function boot(t, approve) {
  const kernel = await createNodeKernel({ users: 'enforce', approve });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-coreutils');
  await kernel.users.add({ name: 'cone', groups: ['sudo'] });
  return kernel;
}

test("sudo prints the approver's denial message, cleaned to one line of at most 500 characters, and 'approval denied' for a plain deny or a message it can't use", async (t) => {
  const throwing = {
    answer: 'deny',
    get message() {
      throw new Error('no message');
    },
  };
  const answers = {
    judge: { answer: 'deny', message: JUDGE },
    later: Promise.resolve({ answer: 'deny', message: 'sudo: denied by the owner: not now' }),
    plain: 'deny',
    unprefixed: { answer: 'deny', message: 'denied by the approval judge: risky' },
    bare: { answer: 'deny', message: 'sudo:   ' },
    number: { answer: 'deny', message: 42 },
    once: { answer: 'once', message: 'sudo: approved' },
    throwing,
    lines: {
      answer: 'deny',
      message: 'sudo: denied by bios:\r\nsee\tthe \u001b[31mlog\u0007\u0000\n',
    },
    long: { answer: 'deny', message: `sudo: ${'x'.repeat(600)}` },
  };
  const kernel = await boot(t, (req) => answers[req.argv[1]]);
  const sudo = (key) => kernel.run(['sudo', 'echo', key], { cwd: '/', user: 'cone' });
  const expected = {
    judge: JUDGE,
    later: 'sudo: denied by the owner: not now',
    plain: 'sudo: approval denied',
    unprefixed: 'sudo: approval denied',
    bare: 'sudo: approval denied',
    number: 'sudo: approval denied',
    once: 'sudo: approval denied',
    throwing: 'sudo: approval denied',
    lines: 'sudo: denied by bios: see the [31mlog',
    long: `sudo: ${'x'.repeat(493)}\u2026`,
  };
  for (const [key, line] of Object.entries(expected)) {
    assert.deepEqual(await sudo(key), { status: 1, stdout: '', stderr: `${line}\n` }, key);
  }
  assert.equal([...expected.long].length, 500);
});

test('an answer that arrived before sudo is interrupted is reported: a denial prints its message, a grant runs nothing and reads withdrawn', async (t) => {
  let term;
  let answer;
  const kernel = await boot(t, () => {
    const decided = Promise.resolve(answer);
    void decided.then(() => term.signal('SIGINT'));
    return decided;
  });
  const sudo = async (given) => {
    answer = given;
    let screen = '';
    term = await kernel.openTerminal(['sudo', 'echo', 'ran'], { cwd: '/', user: 'cone' });
    term.onData = (bytes) => {
      screen += new TextDecoder().decode(bytes);
    };
    return { ...(await term.ended), screen };
  };
  assert.deepEqual(await sudo('deny'), { status: 130, screen: 'sudo: approval denied\r\n' });
  assert.deepEqual(await sudo({ answer: 'deny', message: JUDGE }), {
    status: 130,
    screen: `${JUDGE}\r\n`,
  });
  assert.deepEqual(await sudo('once'), {
    status: 130,
    screen: 'sudo: the request was withdrawn\r\n',
  });
});

test('a request interrupted before any answer reads withdrawn, whatever the approver answers after the abort', async (t) => {
  let term;
  let answer;
  const reasons = [];
  const kernel = await boot(
    t,
    (_req, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          reasons.push(signal.reason);
          resolve(answer);
        });
        setTimeout(() => term.signal('SIGINT'), 0);
      })
  );
  const sudo = async (given) => {
    answer = given;
    let screen = '';
    term = await kernel.openTerminal(['sudo', 'echo', 'ran'], { cwd: '/', user: 'cone' });
    term.onData = (bytes) => {
      screen += new TextDecoder().decode(bytes);
    };
    return { ...(await term.ended), screen };
  };
  const withdrawn = { status: 130, screen: 'sudo: the request was withdrawn\r\n' };
  assert.deepEqual(await sudo({ answer: 'deny', message: JUDGE }), withdrawn);
  assert.deepEqual(await sudo('deny'), withdrawn);
  assert.deepEqual(await sudo('once'), withdrawn);
  assert.deepEqual(reasons, ['withdrawn', 'withdrawn', 'withdrawn']);
});

test('an interrupt that comes while the approver is still being called, before it answers, reads withdrawn', async (t) => {
  let term;
  const kernel = await boot(t, () => {
    term.signal('SIGINT');
    return { answer: 'deny', message: JUDGE };
  });
  let screen = '';
  term = await kernel.openTerminal(['sudo', 'echo', 'ran'], { cwd: '/', user: 'cone' });
  term.onData = (bytes) => {
    screen += new TextDecoder().decode(bytes);
  };
  assert.deepEqual(
    { ...(await term.ended), screen },
    { status: 130, screen: 'sudo: the request was withdrawn\r\n' }
  );
});
