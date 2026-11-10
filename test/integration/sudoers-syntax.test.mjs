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

const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;

const HANDOFF =
  'cone ALL=(cone-32,cone-33,cone-34,cone-35,cone-36) /usr/local/bin/agent send cone --lick=cron --file /tmp/msg-*.md';
const KERNEL_SYNTAX =
  '[NOPASSWD] <user|%group|ALL> [(<target>)] [Cwd <dir>] [Stdin none] [Sha256 <file>=<sha256>…] Cmnd <command…|*>';
const SUDOERS_SYNTAX = '<user|%group|ALL> ALL=[(<target>[,<target>…])] [NOPASSWD:] <command…|ALL>';
const EXPECTED = `expected '${KERNEL_SYNTAX}' or '${SUDOERS_SYNTAX}'`;

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
  const root = (script, options = {}) =>
    kernel.run(['bash', '-c', script], { cwd: '/', ...options });
  const write = async (path, lines, mode = '440') => {
    const text = lines.map((l) => `${l}\n`).join('');
    const r = await root(`printf %s ${quote(text)} > ${path} && chmod ${mode} ${path}`);
    assert.equal(r.status, 0, r.stderr);
  };
  const cone = (script, options = {}) =>
    kernel.run(['bash', '-c', script], { cwd: '/home/cone', user: 'cone', ...options });
  return { kernel, root, write, cone, asked };
}

test('the standard sudoers line from the field matches, as one rule per target user, with the kernel argument semantics', async (t) => {
  let answer = 'once';
  const { kernel, root, cone, asked } = await boot(t, () => answer);
  for (let n = 32; n <= 37; n++) await kernel.users.add({ name: `cone-${n}` });
  const agent = await root(
    'mkdir -p /usr/local/bin && printf \'#!/bin/bash\\necho "$(id -un): $*"\\n\' > /usr/local/bin/agent && chmod 755 /usr/local/bin/agent'
  );
  assert.equal(agent.status, 0, agent.stderr);
  const staged = await cone(`printf '%s\\n' ${quote(HANDOFF)} > /tmp/memory-handoff`);
  assert.equal(staged.status, 0, staged.stderr);
  const installed = await root(
    'install -m 0440 -o root -g root /tmp/memory-handoff /etc/sudoers.d/memory-handoff'
  );
  assert.equal(installed.status, 0, installed.stderr);

  const checked = await cone('visudo -c -f /tmp/memory-handoff');
  assert.deepEqual(
    [checked.status, checked.stdout, checked.stderr],
    [0, '/tmp/memory-handoff: parsed OK\n', '']
  );

  const sent = await cone(
    'sudo -u cone-32 agent send cone --lick=cron --file /tmp/msg-landlording.md'
  );
  assert.equal(sent.status, 0, sent.stderr);
  assert.equal(sent.stderr, '');
  assert.equal(sent.stdout, 'cone-32: send cone --lick=cron --file /tmp/msg-landlording.md\n');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].target, 'cone-32');
  assert.deepEqual(asked[0].argv, [
    'agent',
    'send',
    'cone',
    '--lick=cron',
    '--file',
    '/tmp/msg-landlording.md',
  ]);
  assert.equal(
    (await cone('sudo -u cone-36 agent send cone --lick=cron --file /tmp/msg-x.md')).status,
    0
  );
  assert.equal(asked.at(-1).target, 'cone-36');

  const refused = async (script) => {
    const before = asked.length;
    const r = await cone(script);
    assert.equal(r.status, 1, script);
    assert.match(r.stderr, /^sudo: cone is not allowed to run \/usr\/local\/bin\/agent /, script);
    assert.equal(asked.length, before, script);
  };
  await refused('sudo -u cone-37 agent send cone --lick=cron --file /tmp/msg-x.md');
  await refused('sudo agent send cone --lick=cron --file /tmp/msg-x.md');
  await refused('sudo -u cone-32 agent send cone --lick=cron --file /tmp/msg-a.md /etc/shadow.md');
  await refused('sudo -u cone-32 agent send cone --lick=cron --file /tmp/msg-x.txt');
  await refused('sudo -u cone-32 agent send other --lick=cron --file /tmp/msg-x.md');

  answer = 'deny';
  const listed = await cone('sudo -l');
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stderr, '');
  for (let n = 32; n <= 36; n++) {
    const line = `    (cone-${n}) /usr/local/bin/agent send cone --lick=cron --file /tmp/msg-*.md`;
    assert.ok(listed.stdout.split('\n').includes(line), `${line}\n${listed.stdout}`);
  }
});

test('the common subset of sudoers(5) maps onto kernel rules', async (t) => {
  const { write, cone } = await boot(t);
  await write('/etc/sudoers.d/cone', [
    'cone ALL=(root) NOPASSWD: /usr/bin/printf ""',
    'cone ALL = NOPASSWD:/usr/bin/seq',
    'cone ALL=(ALL:ALL) NOPASSWD: /usr/bin/id -un',
    'cone ALL=(ALL) PASSWD: /usr/bin/true',
    'cone ALL=/usr/bin/echo a\\,b',
    '#includedir /etc/sudoers.d',
  ]);
  const listed = await cone('sudo -l');
  assert.equal(listed.stderr, '');
  assert.equal(
    listed.stdout.split('\n').slice(1).join('\n'),
    [
      '    (root) NOPASSWD: /usr/bin/printf ""',
      '    (root) NOPASSWD: /usr/bin/seq',
      '    (ALL) NOPASSWD: /usr/bin/id -un',
      '    (ALL) /usr/bin/true',
      '    (root) /usr/bin/echo a,b',
      '',
    ].join('\n')
  );
  assert.equal((await cone('sudo -n seq 2')).stdout, '1\n2\n');
  assert.equal((await cone('sudo -n -u cone id -un')).stdout, 'cone\n');
  assert.equal((await cone('sudo -n id -un')).stdout, 'root\n');
  assert.equal((await cone('sudo -n id -u')).status, 1);
  assert.equal((await cone('sudo -n printf x')).status, 1);
  assert.equal((await cone('sudo -n true')).stderr, 'sudo: a password is required\n');
});

const notice = (n) =>
  `sudo: ${n} ${n === 1 ? 'policy line or file was' : 'policy lines or files were'} skipped and grant nothing; ask an administrator to run sudo visudo -c\n`;

test('a line sudo cannot use grants nothing; root sees its file, line and what was expected, anyone else a count', async (t) => {
  const { root, write, cone } = await boot(t);
  await write('/etc/sudoers.d/cone', [
    '# kernel rules',
    'cone ALL=(root) SETENV: /usr/bin/printf',
    'NOPASSWD cone Cmnd /usr/bin/true',
    'cone (cone-32,cone-33) Cmnd /usr/bin/printf',
    'garbage',
  ]);
  const reported = [
    "sudo: /etc/sudoers.d/cone:2: line skipped: the SETENV: tag isn't supported: only NOPASSWD: and PASSWD: are",
    `sudo: /etc/sudoers.d/cone:4: line skipped: (cone-32,cone-33) names one user in this form: write one line per user, or use '${SUDOERS_SYNTAX}'`,
    `sudo: /etc/sudoers.d/cone:5: line skipped: ${EXPECTED}`,
  ].join('\n');
  const ok = await cone('sudo -n true');
  assert.deepEqual([ok.status, ok.stderr], [0, notice(3)]);
  const denied = await cone('sudo -n printf x');
  assert.equal(denied.status, 1);
  assert.equal(
    denied.stderr,
    `${notice(3)}sudo: cone is not allowed to run /usr/bin/printf x as root\n`
  );
  const listed = await cone('sudo -l');
  assert.equal(listed.stderr, notice(3));
  assert.match(listed.stdout, /^ {4}\(root\) NOPASSWD: \/usr\/bin\/true$/m);
  assert.doesNotMatch(listed.stdout, /printf/);

  const asRoot = await root('sudo -n true');
  assert.deepEqual([asRoot.status, asRoot.stderr], [0, `${reported}\n`]);
  assert.equal((await root('sudo -l')).stderr, `${reported}\n`);

  await write('/etc/sudoers.d/cone', ['NOPASSWD cone Cmnd /usr/bin/true']);
  const clean = await cone('sudo -n true');
  assert.deepEqual([clean.status, clean.stderr], [0, '']);
});

test('a non-root caller never sees the name or the tokens of a policy file it cannot read', async (t) => {
  const { kernel, root, write } = await boot(t);
  await kernel.users.add({ name: 'bob' });
  await write('/etc/sudoers.d/canary-secret-project-xyz', [
    'nobody production-leakme-credential-9f3a=(root) /bin/false',
  ]);
  await write('/etc/sudoers.d/open-secret-name', ['ALL Cmnd *'], '666');
  await root('chmod 750 /etc/sudoers.d');
  const bob = (script) => kernel.run(['bash', '-c', script], { cwd: '/', user: 'bob' });
  assert.notEqual((await bob('ls /etc/sudoers.d')).status, 0);
  for (const script of ['sudo -n true', 'sudo -l', 'sudo -n -u bob true']) {
    const r = await bob(script);
    assert.equal(r.status, 1, script);
    assert.ok(r.stderr.startsWith(notice(2)), `${script}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /canary|secret|leakme|9f3a|sudoers\.d/, script);
  }
  const details = await root('sudo -n true');
  assert.equal(details.status, 0);
  assert.match(
    details.stderr,
    /^sudo: \/etc\/sudoers\.d\/canary-secret-project-xyz:1: line skipped: the host must be ALL \(the kernel is one host\), not 'production-leakme-credential-9f3a'$/m
  );
  assert.match(details.stderr, /^sudo: \/etc\/sudoers\.d\/open-secret-name skipped: /m);
});

test('visudo -c -f checks a file the caller can read, line by line, and fails closed on every unsupported form', async (t) => {
  const { write, cone } = await boot(t);
  const lines = [
    'cone ALL=(root) /bin/ls, /bin/cat',
    'cone myhost=(root) /bin/ls',
    'cone ALL=(%wheel) /bin/ls',
    'cone ALL=(:wheel) /bin/ls',
    'cone ALL=(root) NOEXEC: /bin/ls',
    'cone ALL=(root) CWD=/tmp /bin/ls',
    'cone ALL=(root) /usr/bin/*',
    'cone ALL=(root) !/bin/sh',
    'cone ALL=(root) /bin/echo "a b"',
    'cone ALL=(root) /bin/ls # note',
    'cone ALL=(root) ls',
    'cone,cone-2 ALL=(root) /bin/ls',
    'Defaults env_reset',
    'Cmnd_Alias LS = /bin/ls',
    '@include /etc/other',
    '#1000 ALL=(root) ALL',
    'cone Stdin pipe Cmnd /bin/ls',
    'cone Cwd tmp Cmnd /bin/ls',
    'cone Cmnd',
    'cone ALL=(root) /bin/ls \\',
  ];
  await write('/tmp/bad', lines, '644');
  const r = await cone('visudo -c -f /tmp/bad');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  const errors = r.stderr.trimEnd().split('\n');
  assert.equal(errors.length, lines.length, r.stderr);
  for (const [i, line] of errors.entries()) {
    assert.ok(line.startsWith(`visudo: /tmp/bad:${i + 1}: `), line);
  }
  assert.match(errors[0], /unescaped ',' separates entries in sudoers: write one command per line/);
  assert.match(errors[1], /the host must be ALL/);
  assert.match(errors[2], /expected user names or ALL to run as, not '%wheel'/);
  assert.match(errors[3], /runs as the caller with another group/);
  assert.match(errors[4], /the NOEXEC: tag isn't supported/);
  assert.match(errors[5], /the CWD= option isn't supported/);
  assert.match(errors[6], /a wildcard in the command path isn't supported/);
  assert.match(errors[7], /a negated command/);
  assert.match(errors[8], /quotes aren't sudoers syntax/);
  assert.match(errors[9], /a # comment after a rule isn't supported/);
  assert.match(errors[10], /expected an absolute command path, not 'ls'/);
  assert.match(errors[11], /expected one user, %group or ALL per line/);
  assert.match(errors[12], /Defaults aren't supported/);
  assert.match(errors[13], /aliases aren't supported/);
  assert.match(errors[14], /include isn't supported/);
  assert.match(errors[15], /a #uid isn't supported/);
  assert.match(errors[16], /Stdin takes none, not 'pipe'/);
  assert.match(errors[17], /Cwd expects one absolute directory, not 'tmp'/);
  assert.match(errors[18], /expected a command after Cmnd/);
  assert.match(errors[19], /ends in a \\/);

  const piped = await cone('printf "%s\\n" "NOPASSWD cone Cmnd /usr/bin/true" | visudo -cf -');
  assert.deepEqual([piped.status, piped.stdout], [0, 'stdin: parsed OK\n']);
  const quiet = await cone('visudo -cq /tmp/bad');
  assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [1, '', '']);
  const missing = await cone('visudo -c -f /tmp/none');
  assert.deepEqual([missing.status, missing.stderr], [1, 'visudo: /tmp/none: ENOENT\n']);
  const unreadable = await cone('visudo -c -f /etc/sudoers');
  assert.deepEqual([unreadable.status, unreadable.stderr], [1, 'visudo: /etc/sudoers: EACCES\n']);
  const edit = await cone('visudo');
  assert.equal(edit.status, 1);
  assert.match(edit.stderr, /^visudo: only -c is supported/);
});

test('visudo -c checks the whole policy as root, and says so to anyone else', async (t) => {
  const { root, write, cone } = await boot(t);
  await write('/etc/sudoers.d/cone', ['NOPASSWD cone Cmnd /usr/bin/visudo -c', 'cone ALL=(root)']);
  await write('/etc/sudoers.d/open', ['ALL ALL=(ALL) NOPASSWD: ALL'], '666');
  const expected = {
    status: 1,
    stdout: '/etc/sudoers: parsed OK\nDefaults timestamp_timeout=5, timestamp_type=tty\n',
    stderr:
      "visudo: /etc/sudoers.d/cone:2: expected a command after '=': an absolute path, or ALL\n" +
      "visudo: /etc/sudoers.d/open: sudo skips it: it must be root's, no symlink, and writable by root only\n",
  };
  const r = await root('visudo -c');
  assert.deepEqual({ status: r.status, stdout: r.stdout, stderr: r.stderr }, expected);

  const denied = await cone('visudo -c');
  assert.equal(denied.status, 1);
  assert.match(
    denied.stderr,
    /^visudo: \/etc\/sudoers: Permission denied: check the policy as root/
  );

  const viaSudo = await cone('sudo -n visudo -c');
  assert.equal(viaSudo.status, 1);
  assert.equal(viaSudo.stdout, expected.stdout);
  assert.equal(viaSudo.stderr, notice(2) + expected.stderr);

  await root(
    'chmod 440 /etc/sudoers.d/open && printf "NOPASSWD cone Cmnd /usr/bin/visudo -c\\n" > /etc/sudoers.d/cone'
  );
  const clean = await root('visudo -c');
  assert.deepEqual([clean.status, clean.stderr], [0, '']);
  assert.equal(
    clean.stdout,
    '/etc/sudoers: parsed OK\n/etc/sudoers.d/cone: parsed OK\n/etc/sudoers.d/open: parsed OK\nDefaults timestamp_timeout=5, timestamp_type=tty\n'
  );
});
