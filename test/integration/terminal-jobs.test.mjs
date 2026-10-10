import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function session(t) {
  const kernel = await createNodeKernel();
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  let screen = '';
  const decoder = new TextDecoder();
  const term = await kernel.openTerminal(['bash', '-i'], { cwd: '/home' });
  const exited = term.exited.catch(() => undefined);
  t.after(async () => {
    term.write(new TextEncoder().encode('kill -KILL %% 2>/dev/null; exit\r'));
    await Promise.race([exited, tick(3000)]);
    kernel.terminate();
  });
  term.onData = (bytes) => {
    screen += decoder.decode(bytes, { stream: true });
  };
  const until = async (text, from = 0) => {
    for (let i = 0; i < 1500 && !screen.slice(from).includes(text); i++) await tick(10);
    if (!screen.slice(from).includes(text))
      throw new Error(`no ${JSON.stringify(text)} in ${JSON.stringify(screen)}`);
  };
  const type = async (input, expect) => {
    const from = screen.length;
    term.write(new TextEncoder().encode(input));
    if (expect) await until(expect, from);
  };
  const killed = async () => {
    const stopped = screen.length;
    await type('kill -KILL %1\r');
    for (let i = 0; i < 100 && !screen.slice(stopped).includes('Killed'); i++)
      await type('jobs\r', '$ ');
    await until('Killed', stopped);
    await until('$ ', screen.lastIndexOf('Killed'));
  };
  await until('$ ');
  return { type, until, killed, screen: () => screen };
}

test('a job typed at once is stopped or interrupted before it has taken the terminal, and a background job is left alone', async (t) => {
  const s = await session(t);
  await s.type('sleep 30\r', 'sleep 30');
  await s.type('\u001a', '[1]+  Stopped');
  await s.type('jobs\r', '[1]+  Stopped                    sleep 30');
  await s.type('fg\r', 'sleep 30\r\n');
  await s.type('\u0003', '$ ');
  await s.type('echo "rc $?"\r', 'rc 130');
  await s.type('sleep 30\r', 'sleep 30');
  await s.type('\u0003', '$ ');
  await s.type('echo "rc $?"\r', 'rc 130');
  await s.type('sleep 30 &\r', 'sleep 30 &');
  await s.type('\u001a');
  await s.type('jobs\r', 'Running');
  await s.type('kill %1; wait; echo done\r', 'done');
  assert.ok(true);
});

test('a ^Z that comes as soon as the shell has the line stops the job, every time', async (t) => {
  const s = await session(t);
  for (let round = 0; round < 8; round++) {
    await s.type('sleep 30\r', 'sleep 30\r\n');
    await s.type('\u001a', '[1]+  Stopped');
    await s.killed();
  }
  assert.ok(true);
});

test('^C and ^Z reach a job typed 0, 20 or 50 ms after the shell has the line', async (t) => {
  const s = await session(t);
  for (const delay of [0, 20, 50, 0, 20, 50]) {
    await s.type('sleep 30\r', 'sleep 30\r\n');
    if (delay) await tick(delay);
    await s.type('\u0003');
    await s.type('echo "rc=$?"\r', 'rc=130');
    await s.until('$ ', s.screen().lastIndexOf('rc=130'));
    await s.type('sleep 30\r', 'sleep 30\r\n');
    if (delay) await tick(delay);
    await s.type('\u001a', '[1]+  Stopped');
    await s.killed();
  }
  assert.ok(true);
});
