import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const SECURE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const PLACEHOLDER = 'fnox_proxy_0123456789abcdef01234567';
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

function variables(text) {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  );
}

async function boot(t, { approve = () => 'once', lines = [] } = {}) {
  const asked = [];
  const warn = console.warn;
  console.warn = () => undefined;
  t.after(() => {
    console.warn = warn;
  });
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
  for (const name of ['cone', 'lars']) await kernel.users.add({ name, groups: ['sudo'] });
  await kernel.users.add({ name: 'scoop' });
  const root = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  const write = async (path, text, mode = '440') => {
    const r = await root(`printf %s ${quote(text)} > ${path} && chmod ${mode} ${path}`);
    assert.equal(r.status, 0, r.stderr);
  };
  const policy = (...more) =>
    write(
      '/etc/sudoers.d/policy',
      ['NOPASSWD scoop (ALL) Cmnd *', ...more].map((l) => `${l}\n`).join('')
    );
  await policy(...lines);
  const as = (user) => (script) =>
    kernel.run(['bash', '-c', script], { cwd: user ? `/home/${user}` : '/', user });
  const sudoEnv =
    (run) =>
    async (assignments, flags = '') => {
      const r = await run(`${assignments} sudo ${flags} printenv`);
      assert.deepEqual([r.status, r.stderr], [0, '']);
      return variables(r.stdout);
    };
  const cone = as('cone');
  const lars = as('lars');
  const scoop = as('scoop');
  return {
    kernel,
    asked,
    root,
    write,
    policy,
    cone,
    lars,
    scoop,
    coneEnv: sudoEnv(cone),
    larsEnv: sudoEnv(lars),
    scoopEnv: sudoEnv(scoop),
    rootEnv: sudoEnv(root),
  };
}

test('Defaults env_keep += "GH_TOKEN GITHUB_TOKEN" carries those variables of the caller to the command, and no other', async (t) => {
  const { coneEnv, scoopEnv, rootEnv, asked } = await boot(t, {
    lines: ['Defaults env_keep += "GH_TOKEN GITHUB_TOKEN"'],
  });
  const env = await coneEnv('GH_TOKEN=ghp_one GITHUB_TOKEN=gho_two NPM_TOKEN=npm_three');
  assert.equal(asked.length, 1);
  assert.deepEqual(
    [env.GH_TOKEN, env.GITHUB_TOKEN, env.NPM_TOKEN],
    ['ghp_one', 'gho_two', undefined]
  );
  assert.deepEqual(
    [env.SUDO_USER, env.USER, env.LOGNAME, env.HOME, env.PATH, env.PWD],
    ['cone', 'root', 'root', '/root', SECURE_PATH, '/home/cone']
  );
  assert.match(env.SUDO_COMMAND, /\/printenv$/);

  const one = await coneEnv('GH_TOKEN=ghp_only');
  assert.deepEqual([one.GH_TOKEN, 'GITHUB_TOKEN' in one], ['ghp_only', false]);
  const none = await coneEnv('NPM_TOKEN=npm_three');
  assert.deepEqual(
    ['GH_TOKEN' in none, 'GITHUB_TOKEN' in none, 'NPM_TOKEN' in none],
    [false, false, false]
  );

  const sealed = await coneEnv(`GH_TOKEN=${PLACEHOLDER}`);
  assert.equal(sealed.GH_TOKEN, PLACEHOLDER, 'a vault placeholder is a string like any other');
  const empty = await coneEnv('GH_TOKEN=');
  assert.equal(empty.GH_TOKEN, '');

  const nopasswd = await scoopEnv('GH_TOKEN=ghp_scoop NPM_TOKEN=npm_three');
  assert.deepEqual([nopasswd.GH_TOKEN, nopasswd.NPM_TOKEN], ['ghp_scoop', undefined]);
  const other = await scoopEnv('GH_TOKEN=ghp_lars', '-u lars');
  assert.deepEqual([other.GH_TOKEN, other.USER, other.HOME], ['ghp_lars', 'lars', '/home/lars']);
  const root = await rootEnv('GH_TOKEN=ghp_root NPM_TOKEN=npm_three');
  assert.deepEqual(
    [root.GH_TOKEN, root.NPM_TOKEN, root.SUDO_USER],
    ['ghp_root', undefined, 'root']
  );
});

test('env_keep -= removes names, = replaces the list and !env_keep empties it, in file order', async (t) => {
  const { coneEnv, policy } = await boot(t);
  const all = 'A_TOKEN=a B_TOKEN=b C_TOKEN=c D_TOKEN=d';
  const kept = async () => {
    const env = await coneEnv(all);
    return ['A_TOKEN', 'B_TOKEN', 'C_TOKEN', 'D_TOKEN'].filter((name) => name in env).join(' ');
  };

  await policy('Defaults env_keep += "A_TOKEN B_TOKEN"', 'Defaults env_keep -= "B_TOKEN"');
  assert.equal(await kept(), 'A_TOKEN');

  await policy('Defaults env_keep -= "A_TOKEN"', 'Defaults env_keep += "A_TOKEN B_TOKEN"');
  assert.equal(await kept(), 'A_TOKEN B_TOKEN', 'a -= before the += removes nothing');

  await policy('Defaults env_keep += "A_TOKEN"', 'Defaults env_keep = "B_TOKEN\tC_TOKEN"');
  assert.equal(await kept(), 'B_TOKEN C_TOKEN');

  await policy('Defaults env_keep += "A_TOKEN B_TOKEN"', 'Defaults !env_keep');
  assert.equal(await kept(), '');
  await policy(
    'Defaults env_keep += "A_TOKEN B_TOKEN"',
    'Defaults !env_keep',
    'Defaults env_keep+=D_TOKEN'
  );
  assert.equal(await kept(), 'D_TOKEN', 'one name needs no quotes');

  await policy(
    'Defaults env_keep = "A_TOKEN B_TOKEN C_TOKEN", env_keep -= "B_TOKEN", timestamp_timeout=0'
  );
  assert.equal(await kept(), 'A_TOKEN C_TOKEN', 'several settings on one line, in their order');

  await policy('Defaults env_keep += "A_TOKEN"', 'Defaults env_keep -= "A_*"');
  assert.equal(await kept(), 'A_TOKEN', '-= removes the entry as written, not what it matches');
});

test('Defaults:<user> and Defaults:%group env_keep apply to those callers only, after the lines for everyone', async (t) => {
  const { coneEnv, larsEnv, scoopEnv, policy } = await boot(t, {
    lines: ['Defaults:cone env_keep += "GH_TOKEN"', 'Defaults:%sudo env_keep += "TEAM_TOKEN"'],
  });
  const all = 'GH_TOKEN=gh TEAM_TOKEN=team ALL_TOKEN=all';
  const kept = async (sudoEnv) => {
    const env = await sudoEnv(all);
    return ['GH_TOKEN', 'TEAM_TOKEN', 'ALL_TOKEN'].filter((name) => name in env).join(' ');
  };
  assert.equal(await kept(coneEnv), 'GH_TOKEN TEAM_TOKEN');
  assert.equal(await kept(larsEnv), 'TEAM_TOKEN');
  assert.equal(await kept(scoopEnv), '');

  await policy(
    'Defaults:cone env_keep -= "ALL_TOKEN"',
    'Defaults:lars,scoop env_keep += "GH_TOKEN"',
    'Defaults env_keep += "ALL_TOKEN"'
  );
  assert.equal(await kept(coneEnv), '', "the caller's line counts after the one for everyone");
  assert.equal(await kept(larsEnv), 'GH_TOKEN ALL_TOKEN');
  assert.equal(await kept(scoopEnv), 'GH_TOKEN ALL_TOKEN');

  await policy('Defaults env_keep += "GH_TOKEN"', 'Defaults:ALL env_keep = "TEAM_TOKEN"');
  assert.equal(await kept(scoopEnv), 'TEAM_TOKEN');
});

test('env_keep matches as sudo does: * wildcards, NAME=value patterns, no bash functions, LOGNAME with USER, and PATH stays fixed', async (t) => {
  const { cone, coneEnv, policy } = await boot(t, {
    lines: ['Defaults env_keep += "GH_* *_KEY MODE=dry*"'],
  });
  const wild = await coneEnv(
    'GH_TOKEN=1 GH_HOST=2 GH= XGH_TOKEN=3 API_KEY=4 _KEY=5 API_KEYS=6 MY_API_KEY=7'
  );
  assert.deepEqual(
    ['GH_TOKEN', 'GH_HOST', 'GH', 'XGH_TOKEN', 'API_KEY', '_KEY', 'API_KEYS', 'MY_API_KEY'].map(
      (name) => wild[name]
    ),
    ['1', '2', undefined, undefined, '4', '5', undefined, undefined],
    "the text after a * is looked for once, where it first occurs, as sudo's matcher does"
  );
  assert.equal((await coneEnv('MODE=dry-run')).MODE, 'dry-run');
  assert.equal((await coneEnv('MODE=wet')).MODE, undefined, 'a NAME=value pattern needs both');

  const fn = "'() { echo pwned; }'";
  await policy('Defaults env_keep += "GH_TOKEN BASH_FUNC_ok%%=()* NOTFN"');
  const named = await cone(
    `env GH_TOKEN=${fn} 'BASH_FUNC_ok%%=() { echo ok; }' 'NOTFN=()x' sudo printenv BASH_FUNC_ok%% NOTFN GH_TOKEN`
  );
  assert.deepEqual(
    [named.status, named.stdout, named.stderr],
    [1, '() { echo ok; }\n()x\n', ''],
    'a value that starts a bash function is dropped unless the pattern matches the value too'
  );

  await policy('Defaults env_keep += "PATH PWD TERM HOME SHELL USER SUDO_* GH_TOKEN"');
  const fixed = await coneEnv(
    'env -u LOGNAME PATH=/home/cone/bin:$PATH PWD=/elsewhere TERM=../../evil HOME=/home/cone/alt SHELL=/bin/zsh USER=zed SUDO_USER=root SUDO_UID=0 SUDO_NOTE=kept GH_TOKEN=gh'
  );
  assert.deepEqual(
    [fixed.PATH, fixed.PWD, fixed.TERM, fixed.SUDO_USER, fixed.SUDO_UID],
    [SECURE_PATH, '/home/cone', undefined, 'cone', '1000'],
    "PATH, PWD, TERM and sudo's own variables stay the kernel's"
  );
  assert.deepEqual(
    [fixed.HOME, fixed.SHELL, fixed.USER, fixed.LOGNAME, fixed.SUDO_NOTE, fixed.GH_TOKEN],
    ['/home/cone/alt', '/bin/zsh', 'zed', 'zed', 'kept', 'gh']
  );
  const term = await coneEnv('TERM=xterm-256color GH_TOKEN=gh');
  assert.deepEqual([term.TERM, term.GH_TOKEN], ['xterm-256color', 'gh']);

  await policy('Defaults env_keep += "LOGNAME"');
  const user = await coneEnv('');
  assert.deepEqual([user.USER, user.LOGNAME, user.HOME], ['cone', 'cone', '/root']);
});

test('sudo -l shows the env_keep entries that match the caller as sudo does, and visudo -c accepts and lists them', async (t) => {
  const { root, cone, lars, scoop, write } = await boot(t, {
    lines: [
      'Defaults env_keep += "GH_TOKEN GITHUB_TOKEN"',
      'Defaults:cone env_keep -= GITHUB_TOKEN, timestamp_timeout=1',
      'Defaults:lars !env_keep',
      'Defaults:scoop env_keep = "GH_* NPM_TOKEN"',
    ],
  });
  const checked = await root('visudo -c');
  assert.deepEqual([checked.status, checked.stderr], [0, '']);
  assert.match(
    checked.stdout,
    /\/etc\/sudoers\.d\/policy: parsed OK\nDefaults timestamp_timeout=5, timestamp_type=tty, env_keep="GH_TOKEN GITHUB_TOKEN"\nDefaults:cone env_keep-=GITHUB_TOKEN, timestamp_timeout=1\nDefaults:lars !env_keep\nDefaults:scoop env_keep="GH_\* NPM_TOKEN"\n$/
  );
  const l = await cone('sudo -l');
  assert.equal(
    l.stdout.split('\n\n')[0],
    'Matching Defaults entries for cone on slicc:\n    env_keep+="GH_TOKEN GITHUB_TOKEN", env_keep-=GITHUB_TOKEN, timestamp_timeout=1'
  );
  assert.equal(
    (await lars('sudo -l')).stdout.split('\n\n')[0],
    'Matching Defaults entries for lars on slicc:\n    env_keep+="GH_TOKEN GITHUB_TOKEN", !env_keep'
  );
  assert.equal(
    (await scoop('sudo -l')).stdout.split('\n\n')[0],
    'Matching Defaults entries for scoop on slicc:\n    env_keep+="GH_TOKEN GITHUB_TOKEN", env_keep="GH_* NPM_TOKEN"'
  );

  const good = [
    'Defaults env_keep += "GH_TOKEN GITHUB_TOKEN"',
    'Defaults:cone env_keep+=NPM_TOKEN',
  ];
  await write('/tmp/good', good.map((l) => `${l}\n`).join(''), '644');
  const file = await cone('visudo -c -f /tmp/good');
  assert.deepEqual(
    [file.status, file.stdout, file.stderr],
    [
      0,
      '/tmp/good: parsed OK\nDefaults timestamp_timeout=5, timestamp_type=tty, env_keep="GH_TOKEN GITHUB_TOKEN"\nDefaults:cone env_keep+=NPM_TOKEN\n',
      '',
    ]
  );

  const bad = [
    'Defaults env_keep',
    'Defaults env_keep += GH_TOKEN GITHUB_TOKEN',
    'Defaults !env_keep = "GH_TOKEN"',
    'Defaults env_keep += "GH_TOKEN',
    'Defaults env_keep += "GH_\\"TOKEN"',
    'Defaults env_check += "GH_TOKEN"',
    'Defaults env_delete -= "GH_TOKEN"',
    'Defaults !env_reset',
    'Defaults@slicc env_keep += "GH_TOKEN"',
    'Defaults timestamp_timeout += 1',
  ];
  await write('/tmp/bad', bad.map((l) => `${l}\n`).join(''), '644');
  const refused = await cone('visudo -c -f /tmp/bad');
  assert.deepEqual([refused.status, refused.stdout], [1, '']);
  const errors = refused.stderr.trimEnd().split('\n');
  assert.equal(errors.length, bad.length, refused.stderr);
  for (const [i, line] of errors.entries())
    assert.ok(line.startsWith(`visudo: /tmp/bad:${i + 1}: `), line);
  for (const i of [0, 1, 2, 3, 4])
    assert.match(
      errors[i],
      /env_keep takes a double-quoted, space-separated list of names, or one name without quotes, after =, \+= or -= \(!env_keep empties the list\), not '/
    );
  for (const i of [5, 6, 7, 8])
    assert.match(
      errors[i],
      /Defaults aren't supported, except timestamp_timeout, timestamp_type and env_keep for everyone, a user or a %group/
    );
  assert.match(errors[9], /timestamp_timeout takes minutes/);
});

const KEEPER = `export default async function main(ctx) {
  ctx.env.SLICC_SEALED_TICKET = '0'.repeat(32);
  ctx.env.GH_TOKEN = 'ghp_js';
  let answer;
  try {
    answer = await ctx.sudo(['printenv']);
  } catch (err) {
    await ctx.write(2, 'keeper: ' + (err && err.code) + '\\n');
    return 1;
  }
  if (answer.error !== undefined) {
    await ctx.write(2, answer.error + '\\n');
    return 1;
  }
  return (await ctx.wait(answer.pid)).status;
}
`;

test('what env_keep never carries: an exec ticket, even with env_keep = "*", and a request run later has no caller environment', async (t) => {
  const { kernel, cone, asked } = await boot(t, {
    approve: (req) => (req.argv.length === 1 ? 'once' : 'deny'),
    lines: ['Defaults env_keep = "*"'],
  });
  await kernel.writeFile(
    '/node_modules/keeper/package.json',
    JSON.stringify({
      name: 'keeper',
      slicc: { commands: { keeper: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/keeper/main.mjs', KEEPER);
  const r = await cone('MINE=1 keeper');
  assert.deepEqual([r.status, r.stderr], [0, '']);
  const env = variables(r.stdout);
  assert.deepEqual(
    [env.GH_TOKEN, env.MINE, 'SLICC_SEALED_TICKET' in env, env.PATH, env.SUDO_USER],
    ['ghp_js', '1', false, SECURE_PATH, 'cone']
  );

  const denied = await cone('mkdir -p out; GH_TOKEN=ghp_later sudo printenv GH_TOKEN SUDO_USER');
  assert.equal(denied.status, 1);
  const run = await kernel.sudoRun(asked.at(-1), {
    stdout: '/home/cone/out/later.out',
    stderr: '/home/cone/out/later.err',
  });
  assert.equal((await run.ended).status, 1, 'printenv misses GH_TOKEN');
  assert.equal((await cone('cat out/later.out')).stdout, 'cone\n');
});
