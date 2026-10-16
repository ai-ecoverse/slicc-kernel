import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const PROMPT = '\u001b[?2004hbash-5.3# ';

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

async function shell(t) {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  let screen = '';
  const term = await kernel.openTerminal(['bash', '-i'], {
    cwd: '/',
    cols: 80,
    rows: 24,
    onData: (bytes) => {
      screen += new TextDecoder().decode(bytes);
    },
  });
  t.after(() => term.close());
  const until = async (text, from) => {
    const deadline = Date.now() + 60_000;
    while (!screen.slice(from).includes(text)) {
      if (Date.now() > deadline) throw new Error(`waiting for ${JSON.stringify(text)}: ${screen}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const type = async (line) => {
    const from = screen.length;
    term.write(`${line}\r`);
    await until(PROMPT, from);
    return screen.slice(from);
  };
  await until(PROMPT, 0);
  return { term, type, until, screen: () => screen };
}

test('an interactive bash gets SIGWINCH only when the terminal is resized, not from its own write-back of the size at each prompt (#740)', async (t) => {
  const { term, type, until, screen } = await shell(t);
  await type("trap 'echo winched' WINCH");
  let shown = '';
  for (const line of ['true', 'echo one', 'stty size', 'echo two']) shown += await type(line);
  assert.doesNotMatch(shown, /winched/);
  assert.match(shown, /24 80/);
  const from = screen().length;
  term.resize(100, 30);
  await until('winched', from);
  assert.match(await type('stty size; echo "cols $COLUMNS"'), /30 100\r\ncols 100/);
  assert.equal(
    screen()
      .slice(from)
      .match(/winched/g)?.length,
    1
  );
});
