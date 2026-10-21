import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const workflow = await readFile(
  new URL('../../.github/workflows/cert-review-pr.yml', import.meta.url),
  'utf8'
);
const jobs = (() => {
  const body = workflow.split(/^jobs:$/m)[1] ?? '';
  const out = {};
  for (const m of body.matchAll(/^ {2}([a-z-]+):\n([\s\S]*?)(?=^ {2}[a-z-]+:$|(?![\s\S]))/gm))
    out[m[1]] = m[2];
  return out;
})();
const steps = (job) =>
  jobs[job]
    .split(/^ {6}- /m)
    .slice(1)
    .map((text) => {
      const run = /^ {8}run: \|\n((?: {10}.*\n|\n)+)/m.exec(text)?.[1];
      return { text, run: run?.replace(/^ {10}/gm, '') };
    });

const V = '1.2.4-pr.9.77';
const P = '1.2.3-base.9.77';
const hex = (c) => c.repeat(64);

async function fakeApi(t, artifacts) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/repos/o/r/actions/runs/77/artifacts'))
      res.end(JSON.stringify({ artifacts }));
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const sh = (script, env) =>
  new Promise((done) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd: repo,
      env: {
        PATH: process.env.PATH,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_RUN_ID: '77',
        GH_TOKEN: 'x',
        ...env,
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

const check = (api, args) =>
  sh(
    `tools/cert-review/gate.sh artifacts node tools/cert-review/artifacts.mjs --repo o/r --run 77 ${args}`,
    {
      GITHUB_API_URL: api,
    }
  );

const art = (id, name, c) => ({ id, name, digest: `sha256:${hex(c)}`, expired: false });

test('the artifact check passes only when every artifact in the namespace is the one its producer uploaded, by id, name and digest', async (t) => {
  const good = [
    art(1, `kernel-tgz-${V}`, 'a'),
    art(2, `kernel-tgz-${P}`, 'b'),
    art(3, 'unrelated', 'c'),
  ];
  const expect = `--prefix kernel-tgz- --expect kernel-tgz-${V}=1@${hex('a')} --expect kernel-tgz-${P}=2@${hex('b')}`;
  const ok = await check(await fakeApi(t, good), expect);
  assert.equal(ok.code, 0, ok.out);
  assert.match(
    ok.out,
    /^artifacts: PASS every kernel-tgz- artifact of the run is the one its producer job uploaded$/m
  );
  const cases = [
    [
      'an extra artifact in the namespace',
      [...good, art(9, `kernel-tgz-${V}-x`, 'd')],
      /kernel-tgz-1\.2\.4-pr\.9\.77-x \(9\) was uploaded by no producer job/,
    ],
    [
      'the base replaced by another upload of its name',
      [good[0], art(9, `kernel-tgz-${P}`, 'a')],
      /kernel-tgz-1\.2\.3-base\.9\.77: its producer's artifact 2 is gone; kernel-tgz-1\.2\.3-base\.9\.77 \(9\) was uploaded by no producer job/,
    ],
    [
      "a digest that is not the producer's",
      [good[0], art(2, `kernel-tgz-${P}`, 'e')],
      /artifact 2 has digest e{64}, its producer uploaded b{64}/,
    ],
    [
      'an id that names another artifact',
      [good[0], art(2, 'cert-review-verdict-x', 'b')],
      /artifact 2 is named cert-review-verdict-x/,
    ],
  ];
  for (const [what, list, line] of cases) {
    const r = await check(await fakeApi(t, list), expect);
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, /^artifacts: FAIL the run's artifacts are not the producers': /m, what);
    assert.match(r.out, line, what);
  }
  const skipped = await check(
    await fakeApi(t, [art(5, `cert-review-compat-${V}`, 'f')]),
    `--prefix cert-review- --expect cert-review-compat-${V}=@`
  );
  assert.equal(skipped.code, 1, 'a producer that uploaded nothing leaves no artifact by its name');
  const named = `--prefix cert-review- --expect cert-review-suite-release-${V}=*`;
  assert.equal(
    (await check(await fakeApi(t, [art(6, `cert-review-suite-release-${V}`, 'a')]), named)).code,
    0
  );
  const twice = await check(
    await fakeApi(t, [
      art(6, `cert-review-suite-release-${V}`, 'a'),
      art(7, `cert-review-suite-release-${V}`, 'b'),
    ]),
    named
  );
  assert.equal(twice.code, 1);
  assert.match(twice.out, /2 artifacts by that name/);
  assert.equal(
    (await check('http://127.0.0.1:9', expect)).code,
    1,
    'a listing that fails is a FAIL, never a pass'
  );
});

test('same posts "not behaviour (identical dist)" only after the run\'s tarballs check out: a candidate-made artifact named like the base fails the step, and the base comes by the base pack job\'s id', async (t) => {
  const all = steps('same');
  const at = (re) => all.findIndex((s) => re.test(s.text));
  const guard = at(/tools\/cert-review\/artifacts\.mjs/);
  const candidate = at(/artifact-ids: \$\{\{ needs\.pack\.outputs\.id \}\}/);
  const base = at(/artifact-ids: \$\{\{ needs\.pack-base\.outputs\.id \}\}/);
  const same = at(/tools\/cert-review\/same\.mjs/);
  const upload = at(/name: cert-review-same-\$\{\{ needs\.plan\.outputs\.version \}\}/);
  const post = at(/tools\/cert-review\/pr\.mjs same/);
  assert.ok(
    guard >= 0 &&
      guard < candidate &&
      candidate < base &&
      base < same &&
      same < upload &&
      upload < post,
    `${guard} ${candidate} ${base} ${same} ${upload} ${post}`
  );
  assert.match(all[guard].run, /--prefix kernel-tgz- --prefix cert-review- /);
  assert.match(all[guard].run, /--expect "cert-review-delta-\$VERSION=\$DELTA"/);
  assert.match(jobs.same, /needs: \[plan, pack, pack-base, delta\]/);
  assert.doesNotMatch(jobs.same, /continue-on-error|pattern:/);
  assert.match(
    all[guard].text,
    /CANDIDATE: \$\{\{ needs\.pack\.outputs\.id \}\}@\$\{\{ needs\.pack\.outputs\.digest \}\}/
  );
  assert.match(
    all[guard].text,
    /BASE: \$\{\{ needs\.pack-base\.outputs\.id \}\}@\$\{\{ needs\.pack-base\.outputs\.digest \}\}/
  );
  const env = {
    VERSION: V,
    PREV: P,
    CANDIDATE: `1@${hex('a')}`,
    BASE: `2@${hex('b')}`,
    DELTA: `3@${hex('c')}`,
  };
  const honest = [
    art(1, `kernel-tgz-${V}`, 'a'),
    art(2, `kernel-tgz-${P}`, 'b'),
    art(3, `cert-review-delta-${V}`, 'c'),
  ];
  const ok = await sh(all[guard].run, { ...env, GITHUB_API_URL: await fakeApi(t, honest) });
  assert.equal(ok.code, 0, ok.out);
  const forged = [art(1, `kernel-tgz-${V}`, 'a'), art(8, `kernel-tgz-${P}`, 'a')];
  const r = await sh(all[guard].run, { ...env, GITHUB_API_URL: await fakeApi(t, forged) });
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /kernel-tgz-1\.2\.3-base\.9\.77 \(8\) was uploaded by no producer job/);
  const early = await sh(all[guard].run, {
    ...env,
    GITHUB_API_URL: await fakeApi(t, [...honest, art(9, `cert-review-same-${V}`, 'd')]),
  });
  assert.notEqual(
    early.code,
    0,
    'evidence planted under the name same is about to upload stops same before it posts'
  );
  assert.match(
    early.out,
    /cert-review-same-1\.2\.4-pr\.9\.77 \(9\) was uploaded by no producer job/
  );
});

test("record's artifact check covers every producer and fails the record as INCOMPLETE on a planted artifact; no consumer downloads by pattern, and no producer overwrites", async (t) => {
  const all = steps('record');
  const guard = all.find((s) => /tools\/cert-review\/artifacts\.mjs/.test(s.text));
  assert.match(guard.text, /continue-on-error: true/);
  for (const [name, job] of [
    ['kernel-tgz-$VERSION', 'CANDIDATE'],
    ['kernel-tgz-$PREV', 'BASE'],
    ['cert-review-delta-$VERSION', 'DELTA'],
    ['cert-review-same-$VERSION', 'SAME'],
    ['cert-review-compat-$VERSION', 'COMPAT'],
    ['cert-review-verdict-$VERSION', 'VERDICT'],
    ['cert-review-evidence-$VERSION', 'EVIDENCE'],
  ])
    assert.ok(guard.run.includes(`--expect "${name}=$${job}"`), name);
  assert.match(guard.run, /--prefix kernel-tgz- --prefix cert-review-/);
  const record = all.find((s) => /tools\/cert-review\/record\.mjs/.test(s.text));
  assert.match(record.text, /ARTIFACTS: \$\{\{ steps\.artifacts\.outcome \}\}/);
  assert.match(record.run, /--jobs "\$JOBS,artifacts=\$ARTIFACTS"/);
  const env = {
    VERSION: V,
    PREV: P,
    CANDIDATE: `1@${hex('a')}`,
    BASE: `2@${hex('b')}`,
    DELTA: `3@${hex('c')}`,
    SAME: '@',
    COMPAT: `4@${hex('d')}`,
    VERDICT: `5@${hex('e')}`,
    EVIDENCE: `6@${hex('f')}`,
  };
  const honest = [
    art(1, `kernel-tgz-${V}`, 'a'),
    art(2, `kernel-tgz-${P}`, 'b'),
    art(3, `cert-review-delta-${V}`, 'c'),
    art(4, `cert-review-compat-${V}`, 'd'),
    art(5, `cert-review-verdict-${V}`, 'e'),
    art(6, `cert-review-evidence-${V}`, 'f'),
    art(10, `cert-review-suite-release-${V}`, '1'),
    art(11, `cert-review-suite-base-${V}`, '2'),
  ];
  const ok = await sh(guard.run, { ...env, GITHUB_API_URL: await fakeApi(t, honest) });
  assert.equal(ok.code, 0, ok.out);
  for (const planted of [
    art(12, `cert-review-same-${V}`, '3'),
    art(13, `cert-review-record-${V}`, '4'),
  ]) {
    const r = await sh(guard.run, {
      ...env,
      GITHUB_API_URL: await fakeApi(t, [...honest, planted]),
    });
    assert.notEqual(r.code, 0, `${planted.name}: ${r.out}`);
    assert.match(
      r.out,
      new RegExp(
        `${planted.name.replace(/\./g, '\\.')} \\(${planted.id}\\) was uploaded by no producer job`
      )
    );
  }
  for (const text of workflow
    .split(/^ {6}- uses: /m)
    .filter((s) => s.startsWith('actions/download-artifact@'))) {
    assert.doesNotMatch(text.split(/\n {6}- /)[0], /pattern:/);
    if (/artifact-ids:/.test(text)) assert.match(text, /digest-mismatch: error/);
    else
      assert.match(
        text,
        /name: cert-review-suite-(release|base)-\$\{\{ needs\.plan\.outputs\.version \}\}/
      );
  }
  assert.doesNotMatch(workflow, /overwrite: true/);
  assert.doesNotMatch(workflow, /merge-multiple/);
  assert.doesNotMatch(
    jobs['pack-base'],
    /^ +cache:/m,
    "pack base restores no Actions cache: the candidate job, which runs the pull request's code, shares the run's cache scope"
  );
  assert.match(
    jobs['pack-base'],
    /node-version: 26\n {10}package-manager-cache: false\n/,
    "and setup-node's automatic npm cache, which a packageManager field in package.json would switch on, is off"
  );
  for (const job of ['same', 'suite']) {
    for (const [side, v] of [
      ['pack', 'version'],
      ['pack-base', 'prev'],
    ])
      assert.match(
        jobs[job],
        new RegExp(
          `artifact-ids: \\$\\{\\{ needs\\.${side}\\.outputs\\.id \\}\\}\\n {10}path: \\$\\{\\{ runner\\.temp \\}\\}/packs/kernel-tgz-\\$\\{\\{ needs\\.plan\\.outputs\\.${v} \\}\\}\\n`
        ),
        `${job} unpacks ${side} where its script reads it: a download by one id extracts into its path itself`
      );
  }
  assert.match(
    jobs.same,
    /--candidate "\$RUNNER_TEMP\/packs\/kernel-tgz-\$VERSION\/ai-ecoverse-slicc-kernel-\$VERSION\.tgz"/
  );
  assert.match(
    jobs.suite,
    /cp "\$RUNNER_TEMP"\/packs\/kernel-tgz-\*\/\*\.tgz "\$RUNNER_TEMP\/tgz\/"/
  );
  for (const job of ['pack', 'pack-base', 'delta', 'same', 'compat'])
    assert.match(
      jobs[job],
      /id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}\n {6}digest: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/,
      job
    );
});
