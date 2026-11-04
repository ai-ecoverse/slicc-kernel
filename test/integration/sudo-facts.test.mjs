import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const RAN_ONCE = "sudo: ran once; this command line can't be recorded as always\n";

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

const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

async function boot(t, approve = () => 'deny') {
  const asked = [];
  const kernel = await createNodeKernel({
    users: 'enforce',
    approve: (req) => {
      asked.push(req);
      return approve(req);
    },
  });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  await kernel.users.add({ name: 'cone', groups: ['sudo'] });
  const root = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  const rules = async () => (await root('cat /etc/sudoers.d/cone 2>/dev/null')).stdout;
  const policy = async (...lines) => {
    const text = lines.map((l) => `${l}\n`).join('');
    const r = await root(
      `printf %s ${quote(text)} > /etc/sudoers.d/cone && chmod 440 /etc/sudoers.d/cone`
    );
    assert.equal(r.status, 0, r.stderr);
  };
  const cone = (script, options = {}) =>
    kernel.run(['bash', '-c', script], { cwd: '/home/cone', user: 'cone', ...options });
  const terminal = async (argv) => {
    let screen = '';
    const term = await kernel.openTerminal(argv, { cwd: '/home/cone', user: 'cone' });
    term.onData = (bytes) => {
      screen += new TextDecoder().decode(bytes);
    };
    return { ...(await term.ended), screen };
  };
  const last = () => asked.at(-1);
  return { kernel, root, rules, policy, cone, terminal, asked, last };
}

test("a command line with a control or line-separator character is offered with always: false, and an 'always' answer runs it once and records nothing", async (t) => {
  const { kernel, rules, asked, last } = await boot(t, () => 'always');
  const before = await rules();
  for (const arg of ['a\rb', 'a\nb', 'a\u2028b', 'a\u2029b', 'a\u0085b', 'a\u001bb']) {
    const shown = JSON.stringify(arg);
    const n = asked.length;
    const r = await kernel.run(['sudo', 'printf', '%s', arg], { cwd: '/home/cone', user: 'cone' });
    assert.equal(asked.length, n + 1, shown);
    assert.deepEqual(r, { status: 0, stdout: arg, stderr: RAN_ONCE }, shown);
    assert.equal(await rules(), before, shown);
    assert.equal(last().always, false, shown);
    const again = await kernel.run(['sudo', 'printf', '%s', arg], {
      cwd: '/home/cone',
      user: 'cone',
    });
    assert.equal(asked.length, n + 2, shown);
    assert.equal(again.status, 0, shown);
  }
  const ok = await kernel.run(['sudo', 'printf', '%s', 'plain'], {
    cwd: '/home/cone',
    user: 'cone',
  });
  assert.equal(last().always, true);
  assert.deepEqual(ok, { status: 0, stdout: 'plain', stderr: '' });
});

test("the request reports the caller's standard input: a terminal, none, a pipe or a file", async (t) => {
  const { kernel, cone, terminal, last } = await boot(t);
  const stdinOf = async (script, options) => {
    await cone(script, options);
    return last().stdin;
  };
  assert.equal(await cone('printf data > /home/cone/in.txt').then((r) => r.status), 0);
  assert.equal(await stdinOf('sudo true'), 'none');
  assert.equal(await stdinOf('sudo true </dev/null'), 'none');
  assert.equal(await stdinOf('exec 0<&-; sudo true'), 'none');
  assert.equal(await stdinOf('echo hi | sudo true'), 'pipe');
  assert.equal(await stdinOf('sudo true', { stdin: new TextEncoder().encode('x') }), 'pipe');
  assert.equal(await stdinOf('sudo true < /home/cone/in.txt'), 'file');
  await kernel.run(['sudo', 'true'], { cwd: '/home/cone', user: 'cone' });
  assert.equal(last().stdin, 'none');
  await terminal(['sudo', 'true']);
  assert.equal(last().stdin, 'tty');
  await terminal(['bash', '-c', 'sudo true </dev/null']);
  assert.equal(last().stdin, 'none');
});

test('the request reports, for the directory and each path on the line, whether only root can change it', async (t) => {
  const { root, cone, last } = await boot(t);
  assert.equal((await cone('mkdir -p sub && printf x > note.txt')).status, 0);
  assert.equal((await root('ln -s /home/cone/sub /etc/cone-link')).status, 0);
  await cone(
    'sudo cat /etc/passwd note.txt sub/../note.txt /home/cone/missing/x /etc/none/deep --file=/etc/group --mode=0644 -n missing'
  );
  assert.deepEqual(last().rootOnly, {
    '/home/cone': false,
    '/etc/passwd': true,
    '/home/cone/note.txt': false,
    '/home/cone/missing/x': false,
    '/etc/none/deep': true,
    '/etc/group': true,
  });
  assert.equal(last().cwd, '/home/cone');
  await cone('cd / && sudo ls etc home/cone');
  assert.deepEqual(last().rootOnly, { '/': true, '/etc': true, '/home/cone': false });
  await cone('sudo cat /etc/cone-link/../passwd /etc/cone-link/x /etc/../etc/group');
  assert.deepEqual(last().rootOnly, {
    '/home/cone': false,
    '/etc/passwd': false,
    '/etc/cone-link/x': false,
    '/etc/group': true,
  });
  await cone('sudo cat /etc/group /etc/cone-link/../group');
  assert.equal(last().rootOnly['/etc/group'], false);
  await cone('cd /etc && sudo cat hosts');
  assert.equal(last().cwd, '/etc');
  assert.equal(last().rootOnly['/etc'], true);
});

test("an 'always' answer records Stdin none: the rule runs the command with no input or a terminal, and asks again for piped or redirected input", async (t) => {
  let answer = 'always';
  const { rules, cone, terminal, asked } = await boot(t, () => answer);
  const run = async (script, options) => {
    const n = asked.length;
    const r = await cone(script, options);
    return { asked: asked.length - n, status: r.status, out: r.stdout };
  };
  assert.deepEqual(await run('sudo printf %s recorded'), { asked: 1, status: 0, out: 'recorded' });
  assert.equal(
    await rules(),
    'NOPASSWD cone (root) Cwd /home/cone Stdin none Cmnd /usr/bin/printf %s recorded\n'
  );
  answer = 'deny';
  assert.deepEqual(await run('sudo printf %s recorded'), { asked: 0, status: 0, out: 'recorded' });
  assert.deepEqual(await run('sudo printf %s recorded </dev/null'), {
    asked: 0,
    status: 0,
    out: 'recorded',
  });
  let n = asked.length;
  assert.equal((await terminal(['sudo', 'printf', '%s', 'recorded'])).screen, 'recorded');
  assert.equal(asked.length, n);
  assert.deepEqual(await run('echo x | sudo printf %s recorded'), {
    asked: 1,
    status: 1,
    out: '',
  });
  assert.equal(
    (await run('sudo printf %s recorded', { stdin: new TextEncoder().encode('x') })).asked,
    1
  );
  assert.equal((await run('printf x > in.txt; sudo printf %s recorded < in.txt')).asked, 1);
  assert.equal((await run('echo x | sudo -n printf %s recorded')).status, 1);
  answer = 'always';
  n = asked.length;
  assert.equal((await terminal(['sudo', 'printf', '%s', 'at-tty'])).status, 0);
  assert.equal(asked.length, n + 1);
  assert.match(
    await rules(),
    /^NOPASSWD cone \(root\) Cwd \/home\/cone Stdin none Cmnd \/usr\/bin\/printf %s at-tty$/m
  );
  answer = 'deny';
  assert.equal((await run('sudo printf %s at-tty')).asked, 0);
  assert.equal((await run('echo x | sudo printf %s at-tty')).asked, 1);
});

test('a rule without Stdin matches whatever the input, and sudo -l shows Stdin none as STDIN=none', async (t) => {
  const { policy, cone, asked } = await boot(t);
  await policy(
    'NOPASSWD cone (root) Cwd /home/cone Cmnd /usr/bin/printf %s any',
    'NOPASSWD cone (root) Cwd /home/cone Stdin none Cmnd /usr/bin/printf %s quiet',
    'NOPASSWD cone Stdin none Cmnd /usr/bin/seq',
    'NOPASSWD cone (root) Stdin none Cmnd /usr/bin/true',
    'NOPASSWD cone (root) Stdin pipe Cmnd /usr/bin/echo'
  );
  for (const script of [
    'echo x | sudo -n printf %s any',
    'printf x > in.txt; sudo -n printf %s any < in.txt',
    'sudo -n printf %s any',
  ]) {
    const r = await cone(script);
    assert.deepEqual([r.status, r.stdout], [0, 'any'], script);
  }
  assert.equal((await cone('echo x | sudo -n printf %s quiet')).status, 1);
  assert.equal((await cone('sudo -n printf %s quiet')).stdout, 'quiet');
  assert.equal((await cone('sudo -n seq 2')).stdout, '1\n2\n');
  assert.equal((await cone('echo x | sudo -n seq 2')).status, 1);
  assert.equal((await cone('sudo -n echo x')).status, 1);
  assert.equal((await cone('sudo -n true')).status, 0);
  assert.equal((await cone('sudo -n true x')).status, 1);
  const listed = (await cone('sudo -l')).stdout;
  assert.match(listed, /^ {4}\(root\) CWD=\/home\/cone NOPASSWD: \/usr\/bin\/printf %s any$/m);
  assert.match(
    listed,
    /^ {4}\(root\) CWD=\/home\/cone STDIN=none NOPASSWD: \/usr\/bin\/printf %s quiet$/m
  );
  assert.match(listed, /^ {4}\(root\) STDIN=none NOPASSWD: \/usr\/bin\/seq$/m);
  assert.match(listed, /^ {4}\(root\) STDIN=none NOPASSWD: \/usr\/bin\/true ""$/m);
  assert.doesNotMatch(listed, /echo/);
  assert.equal(asked.length, 0);
});
