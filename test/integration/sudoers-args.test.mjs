import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, memoryRoot } from '../../dist/node.js';

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

const MISSING = "printf: missing operand\nTry 'printf --help' for more information.\n";

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
  await kernel.users.add({ name: 'cone' });
  const root = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  const policy = async (...lines) => {
    const text = lines.map((l) => `${l}\n`).join('');
    const r = await root(
      `printf %s ${quote(text)} > /etc/sudoers.d/cone && chmod 440 /etc/sudoers.d/cone`
    );
    assert.equal(r.status, 0, r.stderr);
  };
  const cone = (script, cwd = '/home/cone') =>
    kernel.run(['bash', '-c', script], { cwd, user: 'cone' });
  const sudo = async (args, cwd) => {
    const r = await cone(`sudo -n ${args}`, cwd);
    return { rc: r.status, out: r.stdout, err: r.stderr, refused: /^sudo:/m.test(r.stderr) };
  };
  return { kernel, root, policy, cone, sudo, asked };
}

test('a Cmnd with no arguments allows the program with any arguments, and "" allows it with none', async (t) => {
  const { policy, sudo, cone } = await boot(t);
  await policy('NOPASSWD cone Cmnd /usr/bin/printf');
  assert.deepEqual(await sudo('printf'), { rc: 1, out: '', err: MISSING, refused: false });
  assert.equal((await sudo('printf %s list')).out, 'list');
  assert.equal((await sudo("printf '%s|' a 'b c' '*'")).out, 'a|b c|*|');
  assert.match((await cone('sudo -l')).stdout, /^ {4}\(root\) NOPASSWD: \/usr\/bin\/printf$/m);

  await policy('NOPASSWD cone Cmnd /usr/bin/printf ""');
  assert.equal((await sudo('printf')).err, MISSING);
  const refused = await sudo('printf %s list');
  assert.equal(refused.rc, 1);
  assert.equal(refused.err, 'sudo: cone is not allowed to run /usr/bin/printf %s list as root\n');
  assert.equal((await sudo("printf ''")).rc, 1);
  assert.match((await cone('sudo -l')).stdout, /^ {4}\(root\) NOPASSWD: \/usr\/bin\/printf ""$/m);
});

test('a * argument is a wildcard: alone it stands for any arguments, in a word for any text in that argument', async (t) => {
  const { policy, sudo, cone } = await boot(t);
  await policy('NOPASSWD cone Cmnd /usr/bin/printf *');
  assert.equal((await sudo('printf %s list')).out, 'list');
  assert.equal((await sudo('printf')).err, MISSING);
  assert.match((await cone('sudo -l')).stdout, /^ {4}\(root\) NOPASSWD: \/usr\/bin\/printf \*$/m);

  await policy('NOPASSWD cone Cmnd /usr/bin/printf %s *');
  assert.equal((await sudo('printf %s a b c')).out, 'abc');
  assert.equal((await sudo('printf %s')).refused, false);
  assert.equal((await sudo('printf %d 1')).refused, true);

  await policy('NOPASSWD cone Cmnd /usr/bin/printf %s --file=*.log');
  assert.equal((await sudo('printf %s --file=a.log')).out, '--file=a.log');
  assert.equal((await sudo("printf %s '--file=a b.log'")).out, '--file=a b.log');
  assert.equal((await sudo('printf %s --file=.log')).out, '--file=.log');
  assert.equal((await sudo('printf %s --file=a /etc/shadow.log')).refused, true);
  assert.equal((await sudo('printf %s --file=a.log x')).refused, true);
  assert.equal((await sudo('printf %s --file=a.txt')).refused, true);
  assert.match(
    (await cone('sudo -l')).stdout,
    /^ {4}\(root\) NOPASSWD: \/usr\/bin\/printf %s --file=\*\.log$/m
  );

  await policy('NOPASSWD cone Cmnd /usr/bin/printf * %s* *x');
  assert.equal((await sudo('printf %s %sa bx')).refused, false);
  assert.equal((await sudo('printf a b %s cx')).refused, false);
  assert.equal((await sudo('printf a b %s c x')).refused, true);
  assert.equal((await sudo('printf %s x')).refused, false);
  assert.equal((await sudo('printf %s xa')).refused, true);
});

test('a quoted or escaped * is a literal *', async (t) => {
  const { policy, sudo, cone } = await boot(t);
  for (const word of ['\\*', "'*'", '"*"']) {
    await policy(`NOPASSWD cone Cmnd /usr/bin/printf ${word}`);
    assert.equal((await sudo("printf '*'")).out, '*', word);
    assert.equal((await sudo('printf list')).rc, 1, word);
    assert.equal((await sudo('printf')).rc, 1, word);
    assert.match(
      (await cone('sudo -l')).stdout,
      /^ {4}\(root\) NOPASSWD: \/usr\/bin\/printf \\\*$/m
    );
  }
  await policy('NOPASSWD cone Cmnd /usr/bin/printf a\\**');
  assert.equal((await sudo("printf 'a*b'")).out, 'a*b');
  assert.equal((await sudo('printf ab')).refused, true);
  assert.match(
    (await cone('sudo -l')).stdout,
    /^ {4}\(root\) NOPASSWD: \/usr\/bin\/printf a\\\*\*$/m
  );
});

test('the path is matched exactly, as resolved, and not as a pattern', async (t) => {
  const { policy, sudo } = await boot(t);
  await policy('NOPASSWD cone Cmnd /usr/bin/printf');
  assert.equal((await sudo('/usr/bin/../bin/printf %s x')).out, 'x');
  assert.equal((await sudo('../../usr/bin/printf %s y')).out, 'y');
  assert.equal((await sudo('echo x')).refused, true);
  await policy('NOPASSWD cone Cmnd /usr/bin/print*');
  assert.equal((await sudo('printf x')).refused, true);
});

test("an 'always' answer records its argv, and the line it writes matches that argv only", async (t) => {
  const { root, policy, cone, asked } = await boot(t, () => 'always');
  await policy('cone Cmnd *');
  const run = async (args) => {
    const before = asked.length;
    const r = await cone(`sudo ${args}`);
    return { asked: asked.length - before, rc: r.status, out: r.stdout };
  };
  assert.deepEqual(await run('printf'), { asked: 1, rc: 1, out: '' });
  assert.deepEqual(await run("printf '%s|' '*' 'a b' '' 'x*'"), {
    asked: 1,
    rc: 0,
    out: '*|a b||x*|',
  });
  const text = (await root('cat /etc/sudoers.d/cone')).stdout;
  assert.equal(
    text,
    'cone Cmnd *\n' +
      'NOPASSWD cone (root) Cwd /home/cone Stdin none Cmnd /usr/bin/printf ""\n' +
      "NOPASSWD cone (root) Cwd /home/cone Stdin none Cmnd /usr/bin/printf '%s|' \\* 'a b' '' x\\*\n"
  );
  assert.equal((await run('printf')).asked, 0);
  assert.equal((await run("printf '%s|' '*' 'a b' '' 'x*'")).asked, 0);
  assert.equal((await run('printf x')).asked, 1);
  assert.equal((await run("printf '%s|' anything 'a b' '' 'x*'")).asked, 1);
  assert.equal((await run("printf '%s|' '*' 'a b' '' xyz")).asked, 1);
  assert.equal((await run("printf '%s|' '*' 'a b' ''")).asked, 1);
});

test("an 'always' answer records its command line safely, and runs a command line with a control character once without recording it", async (t) => {
  const { kernel, root, policy, cone, asked } = await boot(t, () => 'always');
  await policy('cone Cmnd *');
  const before = (await root('cat /etc/sudoers.d/cone')).stdout;
  const bad = [
    ['printf', 'a\nb'],
    ['printf', 'a\rb'],
    ['printf', 'a\r\nb'],
    ['printf', 'a\0b'],
    ['printf', "a'\nb"],
  ];
  for (const argv of bad) {
    const n = asked.length;
    const r = await kernel.run(['sudo', ...argv], { cwd: '/home/cone', user: 'cone' });
    assert.equal(asked.length, n + 1, argv.join(' '));
    assert.equal(r.status, 0, argv.join(' '));
    assert.equal(r.stderr, "sudo: ran once; this command line can't be recorded as always\n");
    assert.equal((await root('cat /etc/sudoers.d/cone')).stdout, before, argv.join(' '));
  }
  assert.equal((await cone('sudo -n printf %s other')).stderr, 'sudo: a password is required\n');
  const ok = await cone(`sudo printf '%s|' '*' 'a b' '' 'x*'`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '*|a b||x*|');
  assert.equal(
    (await root('cat /etc/sudoers.d/cone')).stdout,
    before +
      "NOPASSWD cone (root) Cwd /home/cone Stdin none Cmnd /usr/bin/printf '%s|' \\* 'a b' '' x\\*\n"
  );
  assert.equal((await cone(`sudo -n printf '%s|' '*' 'a b' '' 'x*'`)).stdout, '*|a b||x*|');
  assert.equal((await cone('sudo -n printf %s other')).stderr, 'sudo: a password is required\n');
});

test('a kernel-format bare line with a trailing space or carriage return allows only that bare call', async (t) => {
  const { root, policy, sudo, cone } = await boot(t);
  for (const suffix of [' ', '\r', ' \r']) {
    await policy(`NOPASSWD cone (root) Cmnd /usr/bin/printf${suffix}`);
    assert.equal((await sudo('printf')).err, MISSING);
    assert.equal((await sudo('printf %s list')).refused, true);
    assert.match((await cone('sudo -l')).stdout, /^ {4}\(root\) NOPASSWD: \/usr\/bin\/printf ""$/m);
  }
  assert.equal((await root('cat /etc/sudoers.d/cone')).stdout.endsWith(' \r\n'), true);
});

test('a line in the format an always answer wrote for a bare call allows only that call, whenever it was written', async (t) => {
  const root = memoryRoot();
  const start = async () => {
    const kernel = await createNodeKernel({ root, users: 'enforce', approve: () => 'deny' });
    t.after(() => kernel.terminate());
    const sh = (script, user) =>
      kernel.run(['bash', '-c', script], { cwd: user ? '/home/cone' : '/', user });
    const rc = async (args) =>
      /^sudo:/m.test((await sh(`sudo -n ${args}`, 'cone')).stderr) ? 1 : 0;
    return { kernel, sh, rc };
  };
  const first = await start();
  await install(first.kernel, 'wasm-bash');
  await install(first.kernel, 'wasm-coreutils');
  await first.kernel.users.add({ name: 'cone' });
  const recorded =
    'NOPASSWD cone (root) Cmnd /usr/bin/printf\n' +
    'NOPASSWD cone (root) Cwd /home/cone Cmnd /usr/bin/echo\n' +
    'NOPASSWD cone Cmnd /usr/bin/seq\n' +
    "NOPASSWD cone (root) Cwd /home/cone Cmnd /usr/bin/true '*'\n";
  const r = await first.sh(
    `printf %s ${quote(recorded)} > /etc/sudoers.d/cone && chmod 440 /etc/sudoers.d/cone && ` +
      `printf '%s\\n' 'NOPASSWD cone (root) Cmnd /usr/bin/yes' > /etc/sudoers.d/other && ` +
      'chmod 440 /etc/sudoers.d/other'
  );
  assert.equal(r.status, 0, r.stderr);
  const check = async ({ rc, sh }) => {
    assert.equal(await rc('printf'), 0);
    assert.equal(await rc('printf ""'), 1);
    assert.equal(await rc('printf %s widened'), 1);
    assert.equal(await rc('echo'), 0);
    assert.equal(await rc('echo x'), 1);
    assert.equal(await rc('seq 2'), 0);
    assert.equal(await rc('true "*"'), 0);
    assert.equal(await rc('true x'), 1);
    assert.equal(await rc('yes | head -1'), 0);
    assert.equal(await rc('yes x | head -1'), 0);
    assert.match(
      (await sh('sudo -l', 'cone')).stdout,
      /\(root\) NOPASSWD: \/usr\/bin\/printf ""\n.*CWD=\/home\/cone NOPASSWD: \/usr\/bin\/echo ""\n.*NOPASSWD: \/usr\/bin\/seq\n.*NOPASSWD: \/usr\/bin\/true \\\*\n.*NOPASSWD: \/usr\/bin\/yes\n/s
    );
  };
  await check(first);
  await first.kernel.terminate();
  const second = await start();
  await check(second);
  assert.equal((await second.sh('cat /etc/sudoers.d/cone')).stdout, recorded);
});
