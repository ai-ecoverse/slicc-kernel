import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';
import { fakeCronClock } from '../../dist/testing.js';
import { TIMESTAMPS_MAX, Timestamps } from '../../src/sudo-timestamp.ts';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const MINUTE = 60_000;
const PERSON = { answer: 'once', timestamp: true };
const NOT_STAMPED =
  "sudo: approved, but the approver didn't say a person decided, so no timestamp was recorded\n";
const REQUIRED = 'sudo: a password is required\n';
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
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

async function boot(t, { approve = () => PERSON, lines = [] } = {}) {
  const asked = [];
  const logged = [];
  const warn = console.warn;
  console.warn = (...args) => logged.push(args.join(' '));
  t.after(() => {
    console.warn = warn;
  });
  const clock = fakeCronClock();
  const kernel = await createNodeKernel({
    users: 'enforce',
    sudo: { clock },
    approve: (req) => {
      asked.push(req);
      return approve(req);
    },
  });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  for (const name of ['cone', 'lars']) await kernel.users.add({ name, groups: ['sudo'] });
  for (const name of ['scoop', 'nopw']) await kernel.users.add({ name });
  const root = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  const write = async (path, text, mode = '440') => {
    const r = await root(`printf %s ${quote(text)} > ${path} && chmod ${mode} ${path}`);
    assert.equal(r.status, 0, r.stderr);
  };
  const policy = (...more) => write('/etc/sudoers.d/policy', more.map((l) => `${l}\n`).join(''));
  if (lines.length > 0) await policy(...lines);
  const as = (user) => (script) =>
    kernel.run(['bash', '-c', script], { cwd: `/home/${user}`, user });
  const gate = (name) => `: > /tmp/${name}.at; until [ -e /tmp/${name}.go ]; do sleep 0.02; done; `;
  const reached = async (name) => {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (
        await kernel.readFile(`/tmp/${name}.at`).then(
          () => true,
          () => false
        )
      )
        return;
      await tick();
    }
    assert.fail(`the script never reached ${name}`);
  };
  const pass = async (name, ms = 0) => {
    await reached(name);
    clock.advance(ms);
    await kernel.writeFile(`/tmp/${name}.go`, '');
  };
  const runs = () => logged.filter((line) => line.includes(' ; TIMESTAMP='));
  return {
    kernel,
    clock,
    asked,
    logged,
    runs,
    root,
    write,
    policy,
    cone: as('cone'),
    lars: as('lars'),
    scoop: as('scoop'),
    nopw: as('nopw'),
    gate,
    pass,
  };
}

test('every request from this kernel says it takes the timestamp answer, and sudo -v asks with no command', async (t) => {
  const { cone, asked } = await boot(t, { approve: () => 'once' });
  assert.equal((await cone('sudo true')).status, 0);
  assert.equal(asked.at(-1).timestamp, true);
  assert.equal(asked.at(-1).validate, undefined);
  assert.equal(asked.at(-1).argv[0], 'true');
  const v = await cone('sudo -v');
  assert.deepEqual([v.status, v.stdout, v.stderr], [0, '', NOT_STAMPED]);
  const req = asked.at(-1);
  assert.equal(req.timestamp, true);
  assert.equal(req.validate, true);
  assert.deepEqual(req.argv, []);
  assert.equal(req.path, '');
  assert.equal(req.always, false);
  assert.deepEqual(req.rootOnly, {});
  assert.deepEqual(
    [req.kind, req.user, req.target, req.cwd, req.stdin],
    ['sudo', 'cone', 'root', '/home/cone', 'none']
  );
  assert.equal((await cone('sudo -v -u lars')).status, 0);
  assert.equal(asked.at(-1).target, 'lars');
  assert.equal(asked.at(-1).validate, true);
});

test("a person's approval covers the rest of that shell: a loop asks once, logs each run it allowed, and the next shell asks again", async (t) => {
  const { cone, asked, runs } = await boot(t);
  const loop = await cone('for i in 1 2 3; do sudo id -un; done');
  assert.deepEqual([loop.status, loop.stdout, loop.stderr], [0, 'root\nroot\nroot\n', '']);
  assert.equal(asked.length, 1);
  assert.equal(runs().length, 2);
  for (const line of runs()) {
    assert.match(
      line,
      /^sudo: cone : TTY=unknown ; PWD=\/home\/cone ; USER=root ; TIMESTAMP=ppid ; COMMAND=\/\S+\/id -un$/
    );
  }
  const last = await cone('sudo true; sudo id -un');
  assert.deepEqual([last.status, last.stdout], [0, 'root\n']);
  assert.equal(asked.length, 2, 'the sudo bash execs as its last command shares the record');
  assert.equal((await cone('sudo -n true')).stderr, REQUIRED);
  assert.equal((await cone('sudo id -un')).stdout, 'root\n');
  assert.equal(asked.length, 3);
});

test("a plain 'once' never opens the window, and an object without timestamp: true is still a denial", async (t) => {
  for (const answer of ['once', 'always']) {
    const { cone, asked } = await boot(t, { approve: () => answer });
    const r = await cone('sudo true; sudo -n id -un || echo asks; :');
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'asks\n', REQUIRED], answer);
    assert.equal(asked.length, 1, answer);
  }
  const throwing = {
    answer: 'once',
    get timestamp() {
      throw new Error('no timestamp');
    },
  };
  const objects = {
    bare: { answer: 'once' },
    loose: { answer: 'once', timestamp: 'yes' },
    throwing,
  };
  for (const [name, answer] of Object.entries(objects)) {
    const { cone, asked } = await boot(t, { approve: () => answer });
    const r = await cone('sudo true; sudo -n true; :');
    assert.equal(r.stderr, `sudo: approval denied\n${REQUIRED}`, name);
    assert.equal(asked.length, 1, name);
  }
  const { cone, asked, kernel } = await boot(t, {
    approve: (req) => (req.argv[0] === 'id' ? { answer: 'always', timestamp: true } : 'deny'),
  });
  const r = await cone('sudo id -un; sudo true && echo stamped; :');
  assert.deepEqual([r.status, r.stdout], [0, 'root\nstamped\n']);
  assert.equal(asked.length, 1);
  assert.match(
    new TextDecoder().decode(await kernel.readFile('/etc/sudoers.d/cone')),
    /\/id -un\n$/
  );
});

test('the window lasts timestamp_timeout minutes, 5 by default, from the last run, as each run refreshes it', async (t) => {
  const { cone, asked, gate, pass } = await boot(t);
  const ran = cone(
    `sudo true; ${gate('a')} sudo -n true && echo a; ${gate('b')} sudo -n true && echo b; ${gate('c')} sudo -n true || echo c; sudo true; :`
  );
  await pass('a', 4 * MINUTE);
  await pass('b', 4 * MINUTE);
  await pass('c', 5 * MINUTE);
  const r = await ran;
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'a\nb\nc\n', REQUIRED]);
  assert.equal(asked.length, 2);
});

test('two shells of one user keep apart: one stamped while the other waits, and neither opens the other', async (t) => {
  const { cone, asked, gate, pass } = await boot(t);
  const first = cone(`sudo true; ${gate('a')} sudo -n true && echo first; :`);
  await new Promise((resolve) => {
    const wait = () => (asked.length === 1 ? resolve() : setTimeout(wait, 20));
    wait();
  });
  const second = await cone('sudo -n true || echo second; :');
  assert.deepEqual([second.status, second.stdout, second.stderr], [0, 'second\n', REQUIRED]);
  await pass('a');
  assert.equal((await first).stdout, 'first\n');
  assert.equal(asked.length, 1);
});

test('a sudo whose parent has ended neither uses nor writes a timestamp', async (t) => {
  const { kernel, cone, asked, gate, pass } = await boot(t);
  const r = await cone(
    `sudo true; ( ${gate('a')} exec sudo -n true 2>/tmp/orphan.err ) >/dev/null 2>&1 & :`
  );
  assert.equal(r.status, 0);
  await pass('a');
  const deadline = Date.now() + 45_000;
  let err = '';
  while (err === '' && Date.now() < deadline) {
    await tick();
    err = await kernel.readFile('/tmp/orphan.err').then(
      (b) => new TextDecoder().decode(b),
      () => ''
    );
  }
  assert.equal(err, REQUIRED);
  assert.equal(asked.length, 1);
});

test('timestamp_type=global spans every shell of that user only, and sudo -K removes it', async (t) => {
  const { cone, lars, asked, runs } = await boot(t, {
    lines: ['Defaults:cone timestamp_type=global'],
  });
  assert.equal((await cone('sudo true')).status, 0);
  assert.equal((await cone('sudo -n id -un')).stdout, 'root\n');
  assert.match(runs().at(-1), / ; TIMESTAMP=global ; /);
  assert.equal((await lars('sudo -n true')).stderr, REQUIRED);
  assert.equal((await cone('sudo -K')).status, 0);
  assert.equal((await cone('sudo -n true')).stderr, REQUIRED);
  assert.equal(asked.length, 1);
});

test('timestamp_type=tty, the default, keys on the terminal and its session: every command typed there shares it, nothing else does', async (t) => {
  const { kernel, cone, asked, runs } = await boot(t);
  const open = async () => {
    const term = await kernel.openTerminal(['bash', '-i'], { cwd: '/home/cone', user: 'cone' });
    term.screen = '';
    term.onData = (bytes) => {
      term.screen += new TextDecoder().decode(bytes);
    };
    t.after(() => term.close());
    return term;
  };
  const shows = async (term, text) => {
    const deadline = Date.now() + 45_000;
    while (!term.screen.includes(text)) {
      if (Date.now() > deadline) assert.fail(`${text} never in ${JSON.stringify(term.screen)}`);
      await tick();
    }
  };
  const one = await open();
  await shows(one, '$ ');
  one.write('sudo true && echo one-$((1+1))\r');
  await shows(one, 'one-2');
  one.write('sudo -n true && echo two-$((1+1))\r');
  await shows(one, 'two-2');
  one.write('bash -c "sudo -n true && echo nested-ok" ; echo n-$((1+1))\r');
  await shows(one, 'n-2');
  assert.match(one.screen, /nested-ok/);
  assert.equal(asked.length, 1);
  assert.match(
    runs().at(-1),
    /^sudo: cone : TTY=\S+ ; PWD=\/home\/cone ; USER=root ; TIMESTAMP=tty ; /
  );
  assert.doesNotMatch(runs().at(-1), /TTY=unknown/);
  assert.equal((await cone('sudo -n true')).stderr, REQUIRED);
  const two = await open();
  await shows(two, '$ ');
  two.write('sudo -n true || echo other-$((1+1))\r');
  await shows(two, 'other-2');
  one.write('sudo -k; sudo -n true || echo gone-$((1+1))\r');
  await shows(one, 'gone-2');
  assert.equal(asked.length, 1);
});

test('sudo -n runs inside the window and refuses outside it, without asking', async (t) => {
  const { cone, asked, gate, pass } = await boot(t);
  const outside = await cone('sudo -n true');
  assert.deepEqual([outside.status, outside.stderr], [1, REQUIRED]);
  assert.equal(asked.length, 0);
  const ran = cone(`sudo -v; sudo -n id -un; ${gate('a')} sudo -n id -un || echo out; :`);
  await pass('a', 6 * MINUTE);
  const r = await ran;
  assert.deepEqual([r.stdout, r.stderr], ['root\nout\n', REQUIRED]);
  assert.equal(asked.length, 1);
});

test('sudo -k ends the window; sudo -k <command> asks afresh and leaves the record as it was', async (t) => {
  const { cone, scoop, asked } = await boot(t);
  const reset = await cone(
    'sudo -v; sudo -n true && echo in; sudo -k; sudo -n true || echo out; :'
  );
  assert.deepEqual([reset.stdout, reset.stderr], ['in\nout\n', REQUIRED]);
  assert.equal(asked.length, 1);
  const kept = await cone('sudo -v; sudo -k id -un; sudo -n true && echo still; :');
  assert.equal(kept.stdout, 'root\nstill\n');
  assert.equal(asked.length, 3);
  assert.deepEqual(asked.at(-1).argv, ['id', '-un']);
  const fresh = await cone(
    'sudo -k id -un; sudo -n true || echo none; sudo -kv; sudo -n true || echo nor; :'
  );
  assert.equal(fresh.stdout, 'root\nnone\nnor\n');
  assert.equal(asked.length, 5);
  assert.equal(asked.at(-1).validate, true);
  const free = await scoop('sudo -k && sudo -K && echo fine');
  assert.deepEqual([free.status, free.stdout, free.stderr], [0, 'fine\n', '']);
});

test('sudo -v asks a person and starts the window without running anything, and only refreshes it inside', async (t) => {
  const { kernel, cone, scoop, nopw, asked, policy, runs } = await boot(t);
  await policy('NOPASSWD nopw Cmnd /usr/bin/true');
  const needs = await cone('sudo -nv');
  assert.deepEqual([needs.status, needs.stderr], [1, REQUIRED]);
  assert.equal(asked.length, 0);
  const v = await cone('sudo -v && sudo -n id -un && sudo -v && echo again; :');
  assert.deepEqual([v.status, v.stdout, v.stderr], [0, 'root\nagain\n', '']);
  assert.equal(asked.length, 1);
  assert.equal(runs().length, 1);
  const none = await scoop('sudo -v');
  assert.deepEqual(
    [none.status, none.stderr],
    [1, 'Sorry, user scoop may not run sudo on slicc.\n']
  );
  assert.equal((await nopw('sudo -v')).status, 0);
  assert.equal((await kernel.run(['sudo', '-v'], { cwd: '/' })).status, 0);
  assert.equal(asked.length, 1);
});

test('a denied sudo -v starts nothing', async (t) => {
  const { cone, asked } = await boot(t, { approve: () => 'deny' });
  const r = await cone('sudo -v; echo "rc $?"; sudo -n true || echo none; :');
  assert.deepEqual([r.stdout, r.stderr], ['rc 1\nnone\n', `sudo: approval denied\n${REQUIRED}`]);
  assert.equal(asked.length, 1);
});

test('Defaults precedence follows sudoers(5): a Defaults:<user> or %group line beats a global one, and among them the later wins', async (t) => {
  const { cone, lars, asked, policy, gate, pass } = await boot(t, {
    lines: [
      'Defaults timestamp_timeout=0',
      'Defaults:cone timestamp_timeout=10',
      'Defaults timestamp_timeout=0',
    ],
  });
  assert.equal((await cone('sudo true; sudo -n true && echo ten; :')).stdout, 'ten\n');
  assert.equal(asked.length, 1);
  const zero = await lars(
    'sudo true; sudo -n true || echo zero; sudo -v; sudo -n true || echo still; :'
  );
  assert.equal(zero.stdout, 'zero\nstill\n');
  assert.equal(asked.length, 3);

  await policy('Defaults:cone timestamp_timeout=10', 'Defaults:%sudo timestamp_timeout=-1');
  const forever = cone(`sudo true; ${gate('a')} sudo -n true && echo forever; :`);
  await pass('a', 30 * 24 * 60 * MINUTE);
  assert.equal((await forever).stdout, 'forever\n');

  await policy('Defaults:cone timestamp_timeout=0.5, timestamp_type=global');
  const half = cone(
    `sudo true; ${gate('b')} sudo -n true && echo b; ${gate('c')} sudo -n true || echo c; :`
  );
  await pass('b', 29_000);
  await pass('c', 31_000);
  assert.equal((await half).stdout, 'b\nc\n');
  assert.equal(asked.length, 5);
});

test('NOPASSWD and root run as before and never open the window', async (t) => {
  const { kernel, cone, asked, policy } = await boot(t);
  await policy('NOPASSWD cone Cmnd /usr/bin/id -un');
  const r = await cone('sudo id -un; sudo -n true || echo asks; :');
  assert.deepEqual([r.stdout, r.stderr], ['root\nasks\n', REQUIRED]);
  const root = await kernel.run(['bash', '-c', 'sudo true; sudo -n true && echo root'], {
    cwd: '/',
  });
  assert.equal(root.stdout, 'root\n');
  assert.equal(asked.length, 0);
});

test('visudo -c lists the timestamp values that apply, sudo -l shows the matching Defaults, and other Defaults are refused and change nothing', async (t) => {
  const { root, cone, scoop, write, policy, asked } = await boot(t);
  const plain = await root('visudo -c');
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /\nDefaults timestamp_timeout=5, timestamp_type=tty\n$/);
  assert.doesNotMatch((await cone('sudo -l')).stdout, /Defaults/);
  await policy(
    'Defaults timestamp_timeout=2.5,timestamp_type=global',
    'Defaults:cone,%sudo  timestamp_type = ppid',
    'Defaults:scoop !timestamp_timeout'
  );
  const listed = await root('visudo -c');
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(
    listed.stdout,
    /\nDefaults timestamp_timeout=2\.5, timestamp_type=global\nDefaults:cone,%sudo timestamp_type=ppid\nDefaults:scoop timestamp_timeout=0\n$/
  );
  const l = await cone('sudo -l');
  assert.match(
    l.stdout,
    /^Matching Defaults entries for cone on slicc:\n {4}timestamp_timeout=2\.5, timestamp_type=global, timestamp_type=ppid\n\nUser cone may run the following commands on slicc:\n/
  );
  assert.equal((await scoop('sudo -l')).status, 1);

  const bad = [
    'Defaults env_reset',
    'Defaults timestamp_type=kernel',
    'Defaults timestamp_timeout=soon',
    'Defaults timestamp_timeout+=1',
    'Defaults timestamp_timeout',
    'Defaults !timestamp_type',
    'Defaults@slicc timestamp_timeout=1',
    'Defaults>root timestamp_timeout=1',
    'Defaults!/bin/ls timestamp_timeout=1',
    'Defaults:!cone timestamp_timeout=1',
    'Defaults',
    'Defaults timestamp_timeout=1, env_reset',
  ];
  await write('/tmp/bad', bad.map((l) => `${l}\n`).join(''), '644');
  const checked = await cone('visudo -c -f /tmp/bad');
  assert.equal(checked.status, 1);
  assert.equal(checked.stdout, '');
  const errors = checked.stderr.trimEnd().split('\n');
  assert.equal(errors.length, bad.length, checked.stderr);
  for (const [i, line] of errors.entries())
    assert.ok(line.startsWith(`visudo: /tmp/bad:${i + 1}: `));
  for (const i of [0, 6, 7, 8, 11])
    assert.match(
      errors[i],
      /Defaults aren't supported, except timestamp_timeout and timestamp_type/
    );
  assert.match(errors[1], /timestamp_type=kernel isn't supported: use tty, ppid or global/);
  for (const i of [2, 3, 4])
    assert.match(errors[i], /timestamp_timeout takes minutes, such as =5 or =2\.5/);
  assert.match(errors[5], /timestamp_type takes =tty, =ppid or =global, not '!timestamp_type'/);
  assert.match(errors[9], /expected users, %groups or ALL after Defaults:, not '!cone'/);
  assert.match(
    errors[10],
    /expected timestamp_timeout=<minutes> or timestamp_type=<type> after Defaults/
  );

  await write('/tmp/good', 'Defaults:cone timestamp_timeout=1\n', '644');
  const good = await cone('visudo -c -f /tmp/good');
  assert.deepEqual(
    [good.status, good.stdout],
    [
      0,
      '/tmp/good: parsed OK\nDefaults timestamp_timeout=5, timestamp_type=tty\nDefaults:cone timestamp_timeout=1\n',
    ]
  );

  await policy('Defaults env_reset', 'Defaults:cone timestamp_timeout=0, env_reset');
  await write('/etc/sudoers.d/open', 'Defaults:cone timestamp_timeout=0\n', '666');
  const still = await cone('sudo true; sudo -n true && echo window; :');
  assert.equal(still.stdout, 'window\n');
  assert.equal(asked.length, 1);
});

test('sudo prints its usage for flags that do not go together', async (t) => {
  const { cone } = await boot(t);
  for (const script of [
    'sudo',
    'sudo -K true',
    'sudo -Kk',
    'sudo -vl',
    'sudo -v true',
    'sudo -lK',
    'sudo -n',
  ]) {
    const r = await cone(script);
    assert.equal(r.status, 1, script);
    assert.match(
      r.stderr,
      /^usage: sudo -K \| -k\n {7}sudo -v \[-kn\] \[-u user\]\n {7}sudo -l \[-kn\]\n {7}sudo \[-kn\] \[-u user\] \[--\] command \[args\.\.\.\]\n$/,
      script
    );
  }
  assert.match((await cone('sudo -x')).stderr, /^sudo: invalid option -- 'x'\nusage: sudo -K/);
});

test('with users off, sudo -k, -K and -v do nothing and succeed', async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  const r = await kernel.run(['bash', '-c', 'sudo -k && sudo -K && sudo -v && echo ok'], {
    cwd: '/',
  });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'ok\n', '']);
});

test('a record matches only the same process: a reused pid, a new session leader, another user or a clock set back finds none', () => {
  let now = 1_000_000;
  const ts = new Timestamps(() => now);
  const policy = { type: 'ppid', minutes: 5 };
  const shell = { uid: 1000, parent: { pid: 1001, started: 5 } };
  assert.equal(ts.stamp(shell, policy), true);
  assert.equal(ts.current(shell, policy), true);
  assert.equal(ts.current({ uid: 1000, parent: { pid: 1001, started: 6 } }, policy), false);
  assert.equal(ts.current({ uid: 1001, parent: shell.parent }, policy), false);
  assert.equal(ts.current({ uid: 1000 }, policy), false);
  assert.equal(ts.stamp({ uid: 1000 }, policy), false);
  const tty = { type: 'tty', minutes: 5 };
  const term = {
    uid: 1000,
    terminal: { tty: 'pts/0', sid: 1500, started: 7 },
    parent: shell.parent,
  };
  ts.stamp(term, tty);
  assert.equal(ts.current(term, tty), true);
  assert.equal(ts.current({ ...term, terminal: { ...term.terminal, started: 8 } }, tty), false);
  assert.equal(ts.current({ ...term, terminal: { ...term.terminal, tty: 'pts/1' } }, tty), false);
  assert.equal(
    ts.current({ uid: 1000, parent: shell.parent }, tty),
    true,
    'no terminal: the ppid record'
  );
  now -= 1;
  assert.equal(ts.current(shell, policy), false, 'a record from the future counts for nothing');
  now += 1;
  assert.equal(ts.stamp(shell, { type: 'ppid', minutes: 0 }), false);
  for (let pid = 0; pid < TIMESTAMPS_MAX + 10; pid++) {
    ts.stamp({ uid: 1000, parent: { pid, started: 1 } }, { type: 'ppid', minutes: -1 });
  }
  assert.equal(ts.current({ uid: 1000, parent: { pid: 0, started: 1 } }, policy), false);
  assert.equal(
    ts.current({ uid: 1000, parent: { pid: TIMESTAMPS_MAX + 9, started: 1 } }, policy),
    true
  );
  ts.invalidate({ uid: 1000, parent: { pid: TIMESTAMPS_MAX + 9, started: 1 } }, 'ppid');
  assert.equal(
    ts.current({ uid: 1000, parent: { pid: TIMESTAMPS_MAX + 9, started: 1 } }, policy),
    false
  );
  ts.remove(1000);
  assert.equal(
    ts.current({ uid: 1000, parent: { pid: TIMESTAMPS_MAX + 8, started: 1 } }, policy),
    false
  );
});
