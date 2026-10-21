import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

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

const PACKAGE = JSON.stringify({
  name: 'lookup',
  slicc: { commands: { lookup: { abi: 'js', module: 'bin/lookup.mjs' } } },
});

const PROGRAM = `export default async function main(ctx) {
  const out = [];
  for (const spec of ctx.argv.slice(1)) {
    const [name, family] = spec.split('/');
    const options = family === undefined ? undefined : { family: Number(family) };
    try {
      out.push(spec + ' ' + JSON.stringify(await ctx.net.resolve(name, options)));
    } catch (e) {
      out.push(spec + ' ' + e.code);
    }
  }
  const ac = new AbortController();
  ac.abort(new Error('stopped'));
  await ctx.net.resolve('localhost', { signal: ac.signal }).catch((e) => out.push('aborted ' + e.message));
  await ctx.write(1, out.join('\\n') + '\\n');
}
`;

test('ctx.net.resolve answers as the kernel resolver does, by family, with ENOTFOUND for no answer and EAI_FAMILY for a bad family (#913)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile('/node_modules/lookup/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/lookup/bin/lookup.mjs', PROGRAM);
  await kernel.run(['bash', '-c', "printf '10.0.0.9 zzydb\\n::5 zzydb\\n' >> /etc/hosts"], {
    cwd: '/',
  });
  const got = await kernel.run(
    [
      'lookup',
      'localhost',
      'localhost/4',
      'localhost/6',
      'zzydb',
      'zzydb/6',
      '10.1.2.3',
      'nowhere.invalid',
      'localhost/5',
    ],
    { cwd: '/' }
  );
  assert.deepEqual(got, {
    status: 0,
    stdout: [
      'localhost ["127.0.0.1","::1"]',
      'localhost/4 ["127.0.0.1"]',
      'localhost/6 ["::1"]',
      'zzydb ["10.0.0.9","::5"]',
      'zzydb/6 ["::5"]',
      '10.1.2.3 ["10.1.2.3"]',
      'nowhere.invalid ENOTFOUND',
      'localhost/5 EAI_FAMILY',
      'aborted stopped',
      '',
    ].join('\n'),
    stderr: '',
  });
});

test("ctx.net.resolve rejects with EAI_AGAIN when the uplink's lookup fails, keeps ENOTFOUND for a name with no answer, and caches no failure (#1363)", async (t) => {
  const { fakeUplink } = await import('../../dist/testing.js');
  const base = fakeUplink({ names: { 'up.test': ['203.0.113.7'], 'flaky.test': ['203.0.113.8'] } });
  let flaky = 0;
  const uplink = {
    ...base,
    resolve: async (name, family, signal) => {
      if (name === 'down.test') throw Object.assign(new Error('SERVFAIL'), { code: 'EAI_AGAIN' });
      if (name === 'flaky.test' && flaky++ === 0) throw new Error('the resolver is unreachable');
      return base.resolve(name, family, signal);
    },
  };
  const kernel = await createNodeKernel({ users: 'off', network: { uplink } });
  t.after(() => kernel.terminate());
  await kernel.writeFile('/node_modules/lookup/package.json', PACKAGE);
  await kernel.writeFile('/node_modules/lookup/bin/lookup.mjs', PROGRAM);
  const got = await kernel.run(
    ['lookup', 'up.test/4', 'down.test/4', 'none.test/4', 'flaky.test/4', 'flaky.test/4'],
    { cwd: '/' }
  );
  assert.equal(
    got.stdout,
    [
      'up.test/4 ["203.0.113.7"]',
      'down.test/4 EAI_AGAIN',
      'none.test/4 ENOTFOUND',
      'flaky.test/4 EAI_AGAIN',
      'flaky.test/4 ["203.0.113.8"]',
      'aborted stopped',
      '',
    ].join('\n'),
    got.stderr
  );
});
