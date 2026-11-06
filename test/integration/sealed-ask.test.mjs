import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const PH = 'fnox_proxy_0123456789abcdef01234567';

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

const vault = {
  A: { v: 1, state: 'done', placeholder: PH, record: 'active' },
  B: { v: 1, state: 'cancelled' },
  C: { v: 1, state: 'expired' },
  D: { v: 1, error: { code: 'EACCES', message: 'refused by policy' } },
  E: { v: 1, error: { code: 'EAGAIN', message: 'another request is pending' } },
};

async function boot(t) {
  const seen = [];
  const sealed = async (req) => {
    seen.push(req);
    if (req.op === 'list')
      return { v: 1, secrets: [{ name: 'A', placeholder: PH, state: 'active' }] };
    if (req.op === 'placeholder') return { v: 1, placeholder: PH, state: 'active' };
    const answer = vault[req.name];
    return req.reveal && answer.state === 'done' ? { ...answer, value: 'hunter22-value' } : answer;
  };
  const kernel = await createNodeKernel({ users: 'enforce', sealed });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  await kernel.users.add({ name: 'cone' });
  const as = (script, opts = {}) =>
    kernel.run(['bash', '-c', script], { user: 'cone', cwd: '/home/cone', ...opts });
  return { kernel, seen, as };
}

test('sealed ask prints the placeholder or the value, and its exit status names the outcome', async (t) => {
  const { seen, as } = await boot(t);
  const r = await as(
    'for n in A B C D E; do sealed ask $n; echo " $?"; done 2>&1; T=$(sealed ask A --reveal); echo "[$T]"; sealed ask 9; echo " $?"'
  );
  assert.equal(
    r.stdout,
    [
      `${PH} 0`,
      'sealed: B: cancelled',
      ' 1',
      'sealed: C: the request expired',
      ' 124',
      'sealed: D: refused by policy',
      ' 3',
      'sealed: E: another request is pending',
      ' 4',
      '[hunter22-value]',
      ' 2',
      '',
    ].join('\n')
  );
  assert.equal(r.stderr, 'sealed: "9" is not a valid name\n');
  const ask = seen.filter((req) => req.op === 'ask').at(-1);
  assert.equal(ask.reveal, true);
  assert.deepEqual(ask.requester, {
    exe: '/usr/bin/sealed',
    argv: ['sealed', 'ask', 'A', '--reveal'],
    cwd: '/home/cone',
    tty: null,
    stdin: 'none',
  });
  assert.equal(ask.caller.user, 'cone');
});

test('sealed placeholder and list ask no dialog, and the kernel stamps requester on an ask from any program', async (t) => {
  const { seen, as } = await boot(t);
  const listed = await as('sealed placeholder A; echo; sealed list; sealed list --json');
  assert.deepEqual(
    { status: listed.status, stdout: listed.stdout, stderr: listed.stderr },
    {
      status: 0,
      stdout: `${PH}\nA\t${PH}\tactive\n[{"name":"A","placeholder":"${PH}","state":"active"}]\n`,
      stderr: '',
    }
  );
  assert.equal(
    seen.some((req) => 'requester' in req),
    false
  );
  const script = `cd /tmp && exec 3<>/dev/sealed && printf '%s' '{"v":1,"op":"ask","name":"A","requester":{"exe":"/x"}}' >&3 && cat <&3`;
  const r = await as(script, { stdin: 'piped' });
  assert.equal(r.stdout, JSON.stringify(vault.A));
  assert.deepEqual(seen.at(-1).requester, {
    exe: '/usr/bin/bash',
    argv: ['bash', '-c', script],
    cwd: '/tmp',
    tty: null,
    stdin: 'pipe',
  });
  const bad = await as(
    `exec 3<>/dev/sealed; printf '%s' '{"v":1,"op":"ask","name":"A","value":"x"}' >&3 || echo "rc=$?"`
  );
  assert.equal(bad.stdout, 'rc=1\n');
});

test('sealed is a kernel command in /usr/bin that a package cannot replace', async (t) => {
  const { kernel, as } = await boot(t);
  await kernel.writeFile(
    '/node_modules/fake-sealed/package.json',
    JSON.stringify({
      name: 'fake-sealed',
      slicc: { abi: 'js', commands: { sealed: { module: 'm.mjs' } } },
    })
  );
  await kernel.writeFile(
    '/node_modules/fake-sealed/m.mjs',
    'export default async function (ctx) { await ctx.write(1, "fake"); return 0; }'
  );
  const r = await as('command -v sealed; ls /usr/bin/sealed; sealed ask A');
  assert.equal(r.stdout, `/usr/bin/sealed\n/usr/bin/sealed\n${PH}`);
});
