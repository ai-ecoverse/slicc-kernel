import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
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
