import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const SCRIPT = '#!/bin/bash\nid -u\n';
const SWAPPED = '#!/bin/bash\necho swapped\n';
const sha = (text) => createHash('sha256').update(text).digest('hex');
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

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

async function boot(t, approve = () => 'deny') {
  const asked = [];
  const box = { approve };
  const kernel = await createNodeKernel({
    users: 'enforce',
    approve: (req) => {
      asked.push(req);
      return box.approve(req);
    },
  });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  await kernel.users.add({ name: 'cone', groups: ['sudo'] });
  const root = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  const cone = (script) => kernel.run(['bash', '-c', script], { cwd: '/home/cone', user: 'cone' });
  const rules = async () => (await root('cat /etc/sudoers.d/cone 2>/dev/null')).stdout;
  const policy = async (...lines) => {
    const text = lines.map((l) => `${l}\n`).join('');
    const r = await root(
      `printf %s ${quote(text)} > /etc/sudoers.d/cone && chmod 440 /etc/sudoers.d/cone`
    );
    assert.equal(r.status, 0, r.stderr);
  };
  const script = async (text, path = '/home/cone/t.sh') => {
    const r = await cone(`printf %s ${quote(text)} > ${path} && chmod 755 ${path}`);
    assert.equal(r.status, 0, r.stderr);
  };
  return { kernel, root, cone, rules, policy, script, asked, box, last: () => asked.at(-1) };
}

test('a user-owned script runs as root once approved, and the request names it as user-writable with its sha256', async (t) => {
  const { cone, script, last } = await boot(t, () => 'once');
  await script(SCRIPT);
  const r = await cone('sudo ./t.sh');
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '0\n', '']);
  assert.equal(last().path, '/home/cone/t.sh');
  assert.deepEqual(last().userWritable, [{ path: '/home/cone/t.sh', sha256: sha(SCRIPT) }]);
  assert.equal(last().always, true);
});

test('a user-owned script replaced between the approval and the start is refused, and nothing of the new one runs', async (t) => {
  const { cone, script, rules, box } = await boot(t);
  await script(SCRIPT);
  for (const answer of ['once', 'always']) {
    await script(SCRIPT);
    box.approve = async () => {
      await script(SWAPPED);
      return answer;
    };
    const r = await cone('sudo ./t.sh');
    assert.deepEqual(
      [r.status, r.stdout, r.stderr],
      [1, '', 'sudo: /home/cone/t.sh changed since it was approved\n'],
      answer
    );
  }
  assert.equal(await rules(), '');
});

test("an 'always' answer records the user-writable file's sha256, so the rule runs it unchanged and asks again once it changes", async (t) => {
  const { cone, script, rules, asked, box } = await boot(t, () => 'always');
  await script(SCRIPT);
  assert.equal((await cone('sudo ./t.sh')).stdout, '0\n');
  const line = `NOPASSWD cone (root) Cwd /home/cone Stdin none Sha256 /home/cone/t.sh=${sha(SCRIPT)} Cmnd /home/cone/t.sh ""\n`;
  assert.equal(await rules(), line);
  box.approve = () => 'deny';
  const n = asked.length;
  assert.deepEqual((await cone('sudo -n ./t.sh')).stdout, '0\n');
  assert.equal(asked.length, n);
  const listed = (await cone('sudo -l')).stdout;
  assert.match(
    listed,
    new RegExp(
      `^ {4}\\(root\\) CWD=/home/cone STDIN=none SHA256=/home/cone/t\\.sh:${sha(SCRIPT)} NOPASSWD: /home/cone/t\\.sh "" {2}# user-writable command$`,
      'm'
    )
  );
  await script('#!/bin/bash\necho v2\n');
  const denied = await cone('sudo ./t.sh');
  assert.equal(asked.length, n + 1);
  assert.deepEqual([denied.status, denied.stdout], [1, '']);
  assert.equal((await cone('sudo -n ./t.sh')).stderr, 'sudo: a password is required\n');
  box.approve = () => 'always';
  assert.equal((await cone('sudo ./t.sh')).stdout, 'v2\n');
  assert.equal(asked.length, n + 2);
  assert.equal(
    await rules(),
    `${line}NOPASSWD cone (root) Cwd /home/cone Stdin none Sha256 /home/cone/t.sh=${sha('#!/bin/bash\necho v2\n')} Cmnd /home/cone/t.sh ""\n`
  );
});

test("a user's own pnpm command runs as root once approved, binding its script and package.json, and an edit of either asks again", async (t) => {
  const { cone, rules, asked, box, last } = await boot(t, () => 'always');
  const pkg = '/home/cone/.local/share/pnpm/global/5/g/node_modules/hello';
  const bin = '/home/cone/.local/share/pnpm/bin/hello';
  const manifest = (env) =>
    JSON.stringify({ name: 'hello', slicc: { commands: { hello: { script: 'bin/hello', env } } } });
  const hello = '#!/bin/bash\necho hello $(id -u) $HELLO\n';
  const made = await cone(
    `mkdir -p ${pkg}/bin && printf %s ${quote(hello)} > ${pkg}/bin/hello && chmod 755 ${pkg}/bin/hello && printf %s ${quote(manifest({ HELLO: 'a' }))} > ${pkg}/package.json && hello`
  );
  assert.equal(made.stdout, 'hello 1000 a\n', made.stderr);
  assert.equal((await cone(`sudo ${bin}`)).stdout, 'hello 0 a\n');
  assert.deepEqual(last().userWritable, [
    { path: bin, sha256: sha(hello) },
    { path: `${pkg}/bin/hello`, sha256: sha(hello) },
    { path: `${pkg}/package.json`, sha256: sha(manifest({ HELLO: 'a' })) },
  ]);
  assert.match(
    await rules(),
    new RegExp(`Sha256 ${pkg}/package\\.json=${sha(manifest({ HELLO: 'a' }))} Cmnd ${bin} ""\n$`)
  );
  box.approve = () => 'deny';
  const n = asked.length;
  assert.equal((await cone(`sudo ${bin}`)).stdout, 'hello 0 a\n');
  assert.equal(asked.length, n);
  await cone(`printf %s ${quote(manifest({ HELLO: 'b' }))} > ${pkg}/package.json`);
  const denied = await cone(`sudo ${bin}`);
  assert.deepEqual([denied.status, denied.stdout, asked.length], [1, '', n + 1]);
});

test('a granted wasm program loads the bytes that were hashed, not a module cached under the same size and mtime', async (t) => {
  const { kernel, cone, box, asked, last } = await boot(t, () => 'once');
  const good = await readFile(new URL('./fixtures/exetest/bin/exetest.wasm', import.meta.url));
  const evil = Buffer.from(good);
  const at = evil.indexOf('argv0=');
  assert.ok(at > 0);
  evil.write('EVIL0=', at);
  await kernel.writeFile('/tmp/good.wasm', good);
  await kernel.writeFile('/tmp/evil.wasm', evil);
  const cached = await cone(
    'cp /tmp/evil.wasm prog && chmod 755 prog && ./prog && touch -r prog ref && cp /tmp/good.wasm prog && touch -r ref prog'
  );
  assert.equal(cached.stdout, 'exe=/home/cone/prog EVIL0=./prog\n', cached.stderr);
  const once = await cone('sudo ./prog');
  assert.deepEqual([once.status, once.stdout], [0, 'exe=/home/cone/prog argv0=./prog\n']);
  assert.deepEqual(last().userWritable, [{ path: '/home/cone/prog', sha256: sha(good) }]);
  box.approve = () => 'always';
  assert.equal((await cone('sudo ./prog')).stdout, 'exe=/home/cone/prog argv0=./prog\n');
  const n = asked.length;
  assert.equal((await cone('sudo -n ./prog')).stdout, 'exe=/home/cone/prog argv0=./prog\n');
  assert.equal(asked.length, n);
  const script = await cone(
    "printf '#!/home/cone/interp\\n' > t.sh && chmod 755 t.sh && cp /tmp/evil.wasm interp && chmod 755 interp && ./t.sh && touch -r interp ref && cp /tmp/good.wasm interp && touch -r ref interp"
  );
  assert.match(script.stdout, /^exe=\/home\/cone\/interp EVIL0=/, script.stderr);
  box.approve = () => 'once';
  const viaInterp = await cone('sudo ./t.sh');
  assert.equal(viaInterp.status, 0, viaInterp.stderr);
  assert.match(viaInterp.stdout, /^exe=\/home\/cone\/interp argv0=/);
  assert.deepEqual(
    last().userWritable.map((f) => f.path),
    ['/home/cone/t.sh', '/home/cone/interp']
  );
});

test("a user's own JS command runs as root once approved, from the module that was hashed", async (t) => {
  const { cone, last } = await boot(t, () => 'once');
  const pkg = '/home/cone/.local/share/pnpm/global/5/g/node_modules/hi';
  const source =
    'export default async function hi(ctx) { await ctx.write(1, "hi\\n"); return 0; }\n';
  const manifest = JSON.stringify({
    name: 'hi',
    slicc: { commands: { hi: { abi: 'js', module: 'bin/hi.mjs' } } },
  });
  const made = await cone(
    `mkdir -p ${pkg}/bin && printf %s ${quote(source)} > ${pkg}/bin/hi.mjs && printf %s ${quote(manifest)} > ${pkg}/package.json && hi`
  );
  assert.equal(made.stdout, 'hi\n', made.stderr);
  const r = await cone('sudo ~/.local/share/pnpm/bin/hi');
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'hi\n', '']);
  assert.ok(
    last().userWritable.some((f) => f.path === `${pkg}/bin/hi.mjs` && f.sha256 === sha(source))
  );
});

test('a hand-written NOPASSWD line for a user-writable path runs it without asking, whatever it holds, and sudo -l flags it', async (t) => {
  const { cone, script, policy, asked } = await boot(t);
  await script(SCRIPT);
  await policy('NOPASSWD cone Cmnd /home/cone/t.sh', 'NOPASSWD cone Cmnd /usr/bin/id');
  const r = await cone('sudo -n /home/cone/t.sh');
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, '0\n', '']);
  await script('#!/bin/bash\necho edited\n');
  assert.equal((await cone('sudo -n ./t.sh')).stdout, 'edited\n');
  assert.equal(asked.length, 0);
  const listed = (await cone('sudo -l')).stdout;
  assert.match(listed, /^ {4}\(root\) NOPASSWD: \/home\/cone\/t\.sh {2}# user-writable command$/m);
  assert.match(listed, /^ {4}\(root\) NOPASSWD: \/usr\/bin\/id$/m);
});

test('a kernel-form Sha256 clause that does not match the file grants nothing, and a malformed one does not parse', async (t) => {
  const { cone, script, policy, asked, kernel } = await boot(t);
  await script(SCRIPT);
  await policy(`NOPASSWD cone Sha256 /home/cone/t.sh=${sha('other')} Cmnd /home/cone/t.sh`);
  assert.equal((await cone('sudo -n ./t.sh')).stderr, 'sudo: a password is required\n');
  await policy(`NOPASSWD cone Sha256 /home/cone/t.sh=${sha(SCRIPT)} Cmnd /home/cone/t.sh`);
  assert.equal((await cone('sudo -n ./t.sh')).stdout, '0\n');
  await policy(`NOPASSWD cone Sha256 t.sh=${sha(SCRIPT)} Cmnd /home/cone/t.sh`);
  const r = await kernel.run(['visudo', '-c', '-f', '/etc/sudoers.d/cone'], { cwd: '/' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Sha256 expects <absolute file>=<sha256 in hex>/);
  assert.equal(asked.length, 0);
});

test('root-owned commands and scripts behave as before: no user-writable files in the request, and no Sha256 in the recorded rule', async (t) => {
  const { root, cone, rules, script, last, asked } = await boot(t, () => 'always');
  await script(SCRIPT);
  assert.equal(
    (
      await root(
        `mkdir -p /usr/local/bin && printf %s ${quote(SCRIPT)} > /usr/local/bin/rs && chmod 755 /usr/local/bin/rs`
      )
    ).status,
    0
  );
  assert.equal((await cone('sudo rs')).stdout, '0\n');
  assert.equal(Object.hasOwn(last(), 'userWritable'), false);
  assert.equal((await cone('sudo printf %s x')).stdout, 'x');
  assert.equal(Object.hasOwn(last(), 'userWritable'), false);
  assert.equal(
    await rules(),
    'NOPASSWD cone (root) Cwd /home/cone Stdin none Cmnd /usr/local/bin/rs ""\n' +
      'NOPASSWD cone (root) Cwd /home/cone Stdin none Cmnd /usr/bin/printf %s x\n'
  );
  const n = asked.length;
  assert.equal((await cone('sudo -n rs')).stdout, '0\n');
  assert.equal(asked.length, n);
  const listed = (await cone('sudo -l')).stdout;
  assert.doesNotMatch(listed, /user-writable/);
  const bare = await cone('sudo t.sh');
  assert.equal(bare.stderr, 'sudo: t.sh: command not found\n');
});
