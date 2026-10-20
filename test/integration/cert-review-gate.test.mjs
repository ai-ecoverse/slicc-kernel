import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const tools = new URL('../../tools/cert-review/', import.meta.url);
const gate = fileURLToPath(new URL('gate.sh', tools));
const tool = (name) => fileURLToPath(new URL(name, tools));

const run = (args, env = {}) =>
  new Promise((done) => {
    const child = spawn(gate, args, {
      env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    child.on('close', (code) => done({ code, out }));
  });

const sh = (script) => ['bash', '-c', script];

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cert-gate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeApi(t, routes) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      const hit = routes(req.method, req.url);
      res.setHeader('content-type', 'application/json');
      res.statusCode = hit === undefined ? 404 : 200;
      res.end(JSON.stringify(hit ?? {}));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('a gate whose tool prints no verdict fails, so a tool replaced by `true`, an early exit 0 or empty output never reads as a pass', async () => {
  for (const mode of [[], ['--either'], ['--evidence']]) {
    for (const silent of [['true'], sh('echo working; exit 0'), sh('exit 1')]) {
      const r = await run([...mode, 'suite', ...silent]);
      assert.equal(r.code, 70, `${mode} ${silent}`);
      assert.match(r.out, /::error title=suite::suite printed no PASS or FAIL verdict/);
    }
  }
  const missing = await run(['suite']);
  assert.equal(missing.code, 70);
  const other = await run(['pr plan', ...sh("echo 'pr same: PASS x'; echo 'pr planx: PASS'")]);
  assert.equal(other.code, 70, "another tool's verdict, or a longer name, isn't this tool's");
  const late = await run(['pr plan', ...sh("echo 'log pr plan: PASS go=true'")]);
  assert.equal(late.code, 70, 'the verdict starts the line');
});

test("a gate passes on its tool's PASS and exit 0 only; --either keeps the tool's exit, --evidence needs only a verdict", async () => {
  const cases = [
    [[], "echo 'same: PASS identical=true'", 0],
    [[], "echo 'same: PASS'", 0],
    [[], "echo 'same: FAIL x'; exit 1", 1],
    [[], "echo 'same: FAIL x'; exit 2", 2],
    [[], "echo 'same: FAIL x'", 1],
    [[], "echo 'same: PASS x'; exit 3", 3],
    [[], "echo 'same: PASS x'; echo 'same: FAIL y'; exit 1", 1],
    [[], "echo 'same: FAIL x'; echo 'same: PASS y'", 0],
    [[], "echo 'same: PASSED'", 70],
    [['--either'], "echo 'same: FAIL x'", 0],
    [['--either'], "echo 'same: FAIL x'; exit 1", 1],
    [['--either'], "echo 'same: PASS x'", 0],
    [['--evidence'], "echo 'same: FAIL x'; exit 1", 0],
    [['--evidence'], "echo 'same: PASS x'; exit 1", 0],
  ];
  for (const [mode, script, code] of cases) {
    const r = await run([...mode, 'same', ...sh(script)]);
    assert.equal(r.code, code, `${mode} ${script}: ${r.out}`);
  }
  const passed = await run(['same', ...sh("echo 'same: PASS identical=true'")]);
  assert.match(
    passed.out,
    /^same: PASS identical=true$/m,
    "the tool's output still reaches the log"
  );
});

test('pr.mjs plan, same and lookup each end with their verdict, through the gate', async (t) => {
  const api = await fakeApi(t, (method, url) => {
    if (url.startsWith('/repos/o/r/pulls/9/files')) return [{ filename: 'README.md' }];
    if (method === 'POST' && url.startsWith('/repos/o/r/statuses/')) return {};
    return undefined;
  });
  const env = { GITHUB_API_URL: api, GH_TOKEN: 'x' };
  const head = 'h'.repeat(40);
  const common = ['--repo', 'o/r', '--head', head, '--run', '1'];
  const plan = await run(
    [
      'pr plan',
      process.execPath,
      tool('pr.mjs'),
      'plan',
      ...common,
      '--pr',
      '9',
      '--guard',
      'PASS',
      '--action',
      'opened',
      '--labels',
      '',
    ],
    env
  );
  assert.equal(plan.code, 0, plan.out);
  assert.match(plan.out, /^pr plan: PASS go=false$/m);
  const dir = await scratch(t);
  const evidence = join(dir, 'same.json');
  await writeFile(evidence, JSON.stringify({ identical: false, line: 'the dist differs: x' }));
  const same = await run(
    [
      'pr same',
      process.execPath,
      tool('pr.mjs'),
      'same',
      ...common,
      '--pr',
      '9',
      '--evidence',
      evidence,
    ],
    env
  );
  assert.equal(same.code, 0, same.out);
  assert.match(same.out, /^pr same: PASS the dist differs: the full review goes on$/m);
  const lookup = await run(
    [
      'pr lookup',
      process.execPath,
      tool('pr.mjs'),
      'lookup',
      ...common,
      '--base',
      'b'.repeat(40),
      '--guard',
      'FAIL',
    ],
    env
  );
  assert.equal(lookup.code, 1, lookup.out);
  assert.match(
    lookup.out,
    /^pr lookup: FAIL not certified: a pull request in the group changes the reviewer/m
  );
  const usage = await run(['pr bogus', process.execPath, tool('pr.mjs'), 'bogus']);
  assert.equal(usage.code, 2);
  assert.match(usage.out, /^pr bogus: FAIL usage: pr\.mjs plan\|lookup\|same\|notice$/m);
});

test('compat.mjs says FAIL when no kernel-compat run turned up, and delta, pack, record and verify each end with their verdict', async (t) => {
  const dir = await scratch(t);
  const api = await fakeApi(t, (method, url) => {
    if (url.includes('/actions/workflows/kernel-compat.yml/runs')) return { workflow_runs: [] };
    return undefined;
  });
  const compat = await run(
    [
      '--either',
      'compat',
      process.execPath,
      tool('compat.mjs'),
      '--repo',
      'o/r',
      '--version',
      '1.0.1-pr.1.2',
      '--commit',
      'c'.repeat(40),
      '--wait',
      '0',
      '--out',
      join(dir, 'compat.json'),
    ],
    { GITHUB_API_URL: api, GH_TOKEN: 'x' }
  );
  assert.equal(compat.code, 0, compat.out);
  assert.match(compat.out, /^compat: FAIL no kernel-compat run for v1\.0\.1-pr\.1\.2 in time/m);
  const bin = join(dir, 'bin');
  await mkdir(bin);
  for (const name of ['gh', 'npm']) {
    await writeFile(join(bin, name), '#!/bin/sh\necho "[]"\n');
    await chmod(join(bin, name), 0o755);
  }
  const delta = await run(
    [
      'delta',
      process.execPath,
      tool('delta.mjs'),
      '--only',
      '--prev',
      '1.0.0',
      '--version',
      '1.0.1',
      '--out',
      join(dir, 'delta.json'),
    ],
    { PATH: `${bin}:${process.env.PATH}` }
  );
  assert.equal(delta.code, 0, delta.out);
  assert.match(delta.out, /^delta: PASS 0 pull requests, 0 integration test files$/m);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'delta.json'), 'utf8')).files, []);
  for (const [name, args, line] of [
    ['pack', [], /^pack: FAIL usage: --version x\.y\.z\[-pre\] --out DIR$/m],
    ['record', ['--version', 'x'], /^record: FAIL --version must be x\.y\.z$/m],
  ]) {
    const r = await run([name, process.execPath, tool(`${name}.mjs`), ...args]);
    assert.equal(r.code, 2, `${name}: ${r.out}`);
    assert.match(r.out, line);
  }
});

const repo = fileURLToPath(new URL('../../', import.meta.url));

async function steps(file) {
  const text = await readFile(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^( *)run: \|$/.exec(lines[i]);
    if (!m) continue;
    const body = [];
    for (i++; i < lines.length && (lines[i] === '' || lines[i].startsWith(`${m[1]}  `)); i++)
      body.push(lines[i].slice(m[1].length + 2));
    i--;
    out.push(body.join('\n'));
  }
  return out;
}

const gated =
  /tools\/cert-review\/gate\.sh (?:--either |--evidence )?('[a-z ]+'|[a-z]+) node tools\/cert-review\/([a-z]+)\.mjs/g;

test('the workflows call every cert-review tool through gate.sh under its own name, and never call one bare', async () => {
  const seen = [];
  for (const file of ['cert-review-pr.yml', 'release.yml']) {
    for (const script of await steps(file)) {
      const bare = script
        .replace(gated, '')
        .match(/(?:^|[\s;(])node tools\/cert-review\/(?!prompt\.mjs)[a-z]+\.mjs/);
      assert.equal(bare, null, `${file}: a bare tool call in\n${script}`);
      for (const [, name, tool] of script.matchAll(gated)) {
        const n = name.replace(/'/g, '');
        assert.equal(n.split(' ')[0] === 'pr' ? 'pr' : n, tool, `${file}: ${n} gates ${tool}.mjs`);
        seen.push(n);
      }
    }
  }
  assert.deepEqual(seen.sort(), [
    'artifacts',
    'artifacts',
    'compat',
    'delta',
    'downstream',
    'findings',
    'pack',
    'pack',
    'pack',
    'pr lookup',
    'pr notice',
    'pr plan',
    'pr same',
    'record',
    'same',
    'suite',
    'suite',
  ]);
});

test("each gated workflow step fails when its tool is replaced by `true`, and record's conclusion is failure even beside an old record.json that says success", async (t) => {
  const dir = await scratch(t);
  const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'git'), '#!/bin/sh\nexit 0\n');
  await chmod(join(bin, 'git'), 0o755);
  let n = 0;
  const step = async (script, setup = async () => {}) => {
    const temp = join(dir, `t${n++}`);
    await mkdir(join(temp, 'evidence'), { recursive: true });
    await setup(temp);
    const output = join(temp, 'output');
    await writeFile(output, '');
    const r = await new Promise((done) => {
      const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
        cwd: repo,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: temp,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: join(temp, 'summary'),
          GITHUB_ENV: join(temp, 'env'),
          TREE: temp,
          TAGS: 'v1.0.0',
          ...Object.fromEntries(
            [
              'VERSION',
              'PREV',
              'REF',
              'SIDE',
              'PR',
              'HEAD_SHA',
              'BASE_SHA',
              'ACTION',
              'LABEL',
              'LABELS',
              'GUARD',
              'COMMIT',
              'PARENT',
              'WHICH',
              'TAG',
              'SHA256',
              'LATEST',
              'GH_TOKEN',
              'GITHUB_REPOSITORY',
              'GITHUB_RUN_ID',
              'GITHUB_SHA',
              'CERT_CONTEXT',
              'RUN_URL',
              'GH_REPO',
              'PLAN_COMMIT',
              'REVIEW',
              'JOBS',
            ].map((k) => [k, 'x'])
          ),
        },
      });
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.stderr.on('data', (d) => {
        out += d;
      });
      child.on('close', (code) => done({ code, out }));
    });
    return { ...r, output: await readFile(output, 'utf8') };
  };
  const silenced = (script) =>
    script.replace(/node tools\/cert-review\/([a-z]+)\.mjs/g, (m, tool) =>
      tool === 'prompt' ? m : 'true'
    );
  let count = 0;
  for (const file of ['cert-review-pr.yml', 'release.yml']) {
    for (const script of await steps(file)) {
      const names = [...script.matchAll(gated)].map(([, name]) => name.replace(/'/g, ''));
      if (names.length === 0) continue;
      count++;
      const r = await step(silenced(script), (temp) =>
        writeFile(
          join(temp, 'evidence', 'delta.json'),
          JSON.stringify({ files: ['test/integration/a.test.mjs'] })
        )
      );
      const record = names.includes('record');
      if (record) assert.match(r.output, /^conclusion=failure$/m, r.out);
      else
        assert.notEqual(
          r.code,
          0,
          `${file} ${names}: a silent tool passed its step\n${script}\n${r.out}`
        );
      assert.match(r.out, /printed no PASS or FAIL verdict/, `${file} ${names}`);
      if (record) {
        const old = await step(silenced(script), async (temp) => {
          await mkdir(join(temp, 'record'));
          await writeFile(
            join(temp, 'record', 'record.json'),
            JSON.stringify({ state: 'success', commit: 'c' })
          );
          await writeFile(join(temp, 'record', 'line.txt'), 'certified x\n');
        });
        assert.match(old.output, /^conclusion=failure$/m, old.out);
      }
    }
  }
  assert.equal(count, 17);
});
