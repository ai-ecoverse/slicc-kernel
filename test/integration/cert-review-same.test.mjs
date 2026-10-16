import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { manifestOnly } from '../../tools/cert-review/lib.mjs';

const same = fileURLToPath(new URL('../../tools/cert-review/same.mjs', import.meta.url));
const workflow = await readFile(
  new URL('../../.github/workflows/cert-review-pr.yml', import.meta.url),
  'utf8'
);
const CANDIDATE = '1.110.3-pr.9.77';
const BASE = '1.110.2-base.9.77';

async function tarball(dir, side, version, change = () => {}) {
  const root = join(dir, side);
  const pkg = join(root, 'package');
  await mkdir(join(pkg, 'dist'), { recursive: true });
  const files = {
    'package.json': {
      name: '@ai-ecoverse/slicc-kernel',
      version,
      exports: { '.': './dist/node.js' },
      bin: { slicc: 'dist/cli.js' },
      dependencies: {},
      scripts: { build: 'node build.mjs' },
      devDependencies: { esbuild: '0.25.0', '@types/node': '24.0.0' },
    },
    'dist/node.js': `const SLICC_VERSION = "${version}";\nexport const v = SLICC_VERSION;\nexport const fixture = "1.110.2";\n`,
    'dist/cli.js': '#!/usr/bin/env node\nconsole.log("slicc");\n',
    'dist/node.js.map': {
      version: 3,
      sources: ['../src/version.ts'],
      sourcesContent: ['export const v = SLICC_VERSION;\n'],
      mappings: version.length === CANDIDATE.length ? 'AAAA,IAAM' : 'AAAA,IAAO',
      names: [],
    },
  };
  const modes = { 'dist/cli.js': 0o755 };
  const links = {};
  change({ files, modes, links });
  for (const [name, value] of Object.entries(files)) {
    await mkdir(join(pkg, name, '..'), { recursive: true });
    await writeFile(
      join(pkg, name),
      typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
    );
    await chmod(join(pkg, name), modes[name] ?? 0o644);
  }
  for (const [name, target] of Object.entries(links)) await symlink(target, join(pkg, name));
  const file = join(dir, `${side}.tgz`);
  execFileSync('tar', ['-czf', file, '-C', root, 'package']);
  return file;
}

async function compare(t, candidateChange, baseChange) {
  const dir = await mkdtemp(join(tmpdir(), 'cert-same-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const candidate = await tarball(dir, 'candidate', CANDIDATE, candidateChange);
  const base = await tarball(dir, 'base', BASE, baseChange);
  const out = join(dir, 'same.json');
  execFileSync(
    process.execPath,
    [
      same,
      '--candidate',
      candidate,
      '--base',
      base,
      '--candidate-version',
      CANDIDATE,
      '--base-version',
      BASE,
      '--out',
      out,
    ],
    { env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' } }
  );
  return JSON.parse(await readFile(out, 'utf8'));
}

test('a devDependency bump whose build differs only in the baked version (and the source-map columns and gitHead it shifts) is not behaviour, and the evidence names the rule and both sha256', async (t) => {
  const r = await compare(t, ({ files }) => {
    files['package.json'].devDependencies['@types/node'] = '24.1.0';
    files['package.json'].scripts.lint = 'biome check';
  });
  assert.equal(r.identical, true, JSON.stringify(r.differences));
  assert.match(r.candidate.sha256, /^[0-9a-f]{64}$/);
  assert.match(r.base.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(r.candidate.sha256, r.base.sha256);
  assert.equal(
    r.line,
    `not behaviour (identical dist): ${r.candidate.sha256.slice(0, 12)} = ${r.base.sha256.slice(0, 12)} after normalising ${CANDIDATE}/${BASE}`
  );
  assert.match(r.rule, /^identical dist: only package\.json or its lock changed/);
  const gitHead = await compare(t, ({ files }) => {
    files['package.json'].gitHead = 'a'.repeat(40);
  });
  assert.equal(gitHead.identical, true, JSON.stringify(gitHead.differences));
});

test('only the exact side version is normalised: a version in one more place, or a looser match of it, is a difference and goes to the full review', async (t) => {
  const extra = await compare(t, ({ files }) => {
    files['dist/node.js'] += `export const again = "${CANDIDATE}";\n`;
  });
  assert.equal(extra.identical, false);
  assert.deepEqual(extra.differences, ['dist/node.js differs']);
  const core = await compare(t, ({ files }) => {
    files['dist/node.js'] = files['dist/node.js'].replace('"1.110.2"', '"1.110.3"');
  });
  assert.equal(core.identical, false);
  assert.deepEqual(core.differences, ['dist/node.js differs']);
});

test('what ships decides: a runtime dependency, exports or bin, other dist bytes, a new file, a mode or a symlink for a file is behaviour', async (t) => {
  const cases = [
    [
      ({ files }) => (files['package.json'].dependencies = { tslib: '2.8.1' }),
      'package.json differs beyond devDependencies, scripts, version and gitHead',
    ],
    [
      ({ files }) => (files['package.json'].exports['./wasi'] = './dist/wasi.js'),
      'package.json differs beyond devDependencies, scripts, version and gitHead',
    ],
    [
      ({ files }) => (files['package.json'].bin.other = 'dist/cli.js'),
      'package.json differs beyond devDependencies, scripts, version and gitHead',
    ],
    [({ files }) => (files['dist/cli.js'] += '// bundled differently\n'), 'dist/cli.js differs'],
    [({ files }) => (files['dist/extra.js'] = 'x\n'), 'dist/extra.js only in the candidate'],
    [
      ({ files }) => (files['dist/node.js.map'].sourcesContent = ['export const v = 2;\n']),
      'dist/node.js.map differs beyond its mappings',
    ],
    [({ modes }) => (modes['dist/cli.js'] = 0o644), 'dist/cli.js mode 644 vs 755'],
    [
      ({ files, links }) => {
        delete files['dist/cli.js'];
        links['dist/cli.js'] = 'node.js';
      },
      'dist/cli.js is a symlink in the candidate and a file in the base',
    ],
  ];
  for (const [change, difference] of cases) {
    const r = await compare(t, change);
    assert.equal(r.identical, false, difference);
    assert.deepEqual(r.differences, [difference]);
    assert.match(r.line, /^the dist differs: /);
  }
});

test('the identical-dist rule applies only to a pull request whose behaviour files are package.json and its lock, never with src or the reviewer', () => {
  assert.equal(
    manifestOnly([{ filename: 'package.json' }, { filename: 'package-lock.json' }]),
    true
  );
  assert.equal(manifestOnly([{ filename: 'package-lock.json' }, { filename: 'README.md' }]), true);
  assert.equal(
    manifestOnly([{ filename: 'package.json' }, { filename: 'src/kernel/a.ts' }]),
    false
  );
  assert.equal(
    manifestOnly([{ filename: 'package.json' }, { filename: 'tools/cert-review/lib.mjs' }]),
    false
  );
  assert.equal(manifestOnly([{ filename: 'package.json' }, { filename: 'build.mjs' }]), false);
  assert.equal(manifestOnly([{ filename: 'README.md' }]), false);
});

test('the workflow compares the packed sides only for a manifest-only change, and an identical dist skips the suites, kernel-compat, the review and the record', () => {
  const body = (name) =>
    new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[a-z-]+:\\n|$)`).exec(workflow)?.[1] ?? '';
  assert.match(
    body('same'),
    /needs: \[plan, pack\]\n {4}if: \$\{\{ !cancelled\(\) && needs\.plan\.outputs\.go == 'true' && needs\.plan\.outputs\.manifest == 'true' && needs\.pack\.result == 'success' \}\}/
  );
  assert.match(body('same'), /node tools\/cert-review\/same\.mjs --candidate /);
  assert.match(body('same'), /node tools\/cert-review\/pr\.mjs same /);
  for (const name of ['suite', 'compat', 'review', 'record', 'report']) {
    assert.match(body(name), /needs: \[[^\]]*\bsame\b[^\]]*\]/, `${name} needs same`);
    assert.match(
      body(name),
      /needs\.same\.outputs\.identical != 'true'/,
      `${name} skips an identical dist`
    );
  }
});
