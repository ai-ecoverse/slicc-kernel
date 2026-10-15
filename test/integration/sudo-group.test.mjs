import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

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

const PIDS =
  'pids() { for d in /proc/[0-9]*; do read -r -d "" a < $d/cmdline 2>/dev/null; [ "$a" = "$1" ] && echo ${d#/proc/}; done; true; }; ';

async function boot(t) {
  const kernel = await createNodeKernel({ users: 'enforce', approve: () => 'once' });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  await kernel.users.add({ name: 'cone', groups: ['sudo'] });
  const root = (script) => kernel.run(['bash', '-c', PIDS + script], { cwd: '/' });
  await root(
    "printf 'NOPASSWD cone Cmnd *\\n' > /etc/sudoers.d/cone && chmod 440 /etc/sudoers.d/cone"
  );
  const pids = async (name) => (await root(`pids ${name}`)).stdout.split('\n').filter(Boolean);
  const until = async (check, what) => {
    for (let i = 0; i < 600; i++) {
      if (await check()) return;
      await tick(100);
    }
    assert.fail(`timed out: ${what}`);
  };
  return { kernel, root, pids, until };
}

test('sudo relays a signal to its command\u2019s whole process group, the command\u2019s children included', async (t) => {
  const { kernel, root, pids, until } = await boot(t);
  const ran = kernel.run(
    ['bash', '-c', 'sudo sh -c "sleep 100 & sleep 101; echo no"; echo "rc $?"'],
    { cwd: '/', user: 'cone' }
  );
  await until(async () => (await pids('sleep')).length === 2, 'two sleeps');
  const [sudo] = await pids('sudo');
  await root(`kill -TERM ${sudo}`);
  assert.equal((await ran).stdout, 'rc 143\n');
  await until(async () => (await pids('sleep')).length === 0, 'both sleeps ended');
});

test('sudo on a terminal: ^C and ^Z reach its command, fg resumes it, and bash reads again after a kill -9 of sudo', async (t) => {
  const { kernel, root, pids, until } = await boot(t);
  const term = await kernel.openTerminal(['bash', '-i'], { cwd: '/home/cone', user: 'cone' });
  let screen = '';
  term.onData = (bytes) => {
    screen += new TextDecoder().decode(bytes);
  };
  const shows = (text) =>
    until(() => screen.includes(text), `${JSON.stringify(text)} in ${JSON.stringify(screen)}`);
  await until(() => /[$#] /.test(screen), 'a prompt');
  term.write('sudo sleep 200; echo "rc $?"\r');
  await until(async () => (await pids('sleep')).length === 1, 'a sleep');
  term.write('\u0003');
  await shows('rc 130');
  term.write('sudo sh -c "sleep 0.6; echo sl\\"\\"ept"\r');
  await until(async () => (await pids('sleep')).length === 1, 'a sleep');
  term.write('\u001a');
  await shows('Stopped');
  term.write('fg\r');
  await shows('slept');
  await until(async () => (await pids('sudo')).length === 0, 'sudo done');
  term.write('sudo sleep 300\r');
  await until(async () => (await pids('sleep')).length === 1, 'a sleep');
  await root(`kill -9 $(pids sudo)`);
  await shows('Killed');
  term.write('echo "back $((40+2))"\r');
  await shows('back 42');
  await root('kill -9 $(pids sleep)');
  term.close();
});
