#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  behaviourFiles,
  covers,
  groupVerdict,
  mergedPrs,
  NAME,
  older,
  provenanceProblems,
  releaseNotes,
  statusAt,
  verdict,
} from './lib.mjs';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    repo: { type: 'string', default: 'ai-ecoverse/slicc-kernel' },
    run: { type: 'string', default: '' },
    wait: { type: 'string', default: '3600' },
    notes: { type: 'string', default: 'write' },
  },
});
const { version, repo } = values;
const problems = [];
const facts = {};
const one = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
const gh = (path) => JSON.parse(sh('gh', ['api', path]));
const ghAll = (path) =>
  JSON.parse(sh('gh', ['api', '--paginate', '--slurp', path])).flatMap((page) =>
    Array.isArray(page) ? page : (page.commits ?? [])
  );
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const summary = (text) => {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
};

function npmView(spec, field) {
  try {
    return JSON.parse(
      sh('npm', ['view', spec, ...(field ? [field] : []), '--json', '--prefer-online'])
    );
  } catch (error) {
    if (/E404|No match found/.test(`${error.stdout ?? ''}${error.stderr ?? ''}`)) return undefined;
    throw error;
  }
}

async function meta() {
  const until = Date.now() + Number(values.wait) * 1000;
  let waited = false;
  for (;;) {
    const m = npmView(`${NAME}@${version}`);
    if (m?.version === version && m.dist?.tarball) {
      const head = await fetch(m.dist.tarball, { method: 'HEAD' });
      if (head.ok) return m;
    }
    if (Date.now() > until)
      throw new Error(`npm doesn't serve ${NAME}@${version} after ${values.wait} s`);
    if (!waited)
      console.log(`npm doesn't serve ${NAME}@${version} yet: waiting up to ${values.wait} s`);
    waited = true;
    await sleep(15_000);
  }
}

async function download(m) {
  const url = new URL(m.dist.tarball);
  if (url.origin !== 'https://registry.npmjs.org')
    return problems.push(`the tarball is at ${url.origin}`);
  const res = await fetch(url);
  if (!res.ok) return problems.push(`downloading ${url} answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha512 = createHash('sha512').update(bytes);
  facts.integrity = `sha512-${sha512.copy().digest('base64')}`;
  facts.sha512 = sha512.digest('hex');
  facts.sha256 = createHash('sha256').update(bytes).digest('hex');
  if (m.dist.integrity !== facts.integrity)
    problems.push(`dist.integrity is ${m.dist.integrity}, the tarball is ${facts.integrity}`);
  return undefined;
}

async function provenance(m) {
  const url = m.dist.attestations?.url;
  if (!url) return problems.push('no attestations on npm');
  const res = await fetch(url);
  if (!res.ok) return problems.push(`attestations answered ${res.status}`);
  const bundle = ((await res.json()).attestations ?? []).find(
    (b) => b.predicateType === 'https://slsa.dev/provenance/v1'
  );
  if (!bundle) return problems.push('no SLSA provenance attestation');
  const statement = JSON.parse(
    Buffer.from(bundle.bundle.dsseEnvelope.payload, 'base64').toString('utf8')
  );
  const found = provenanceProblems(statement, {
    repo,
    version,
    sha512: facts.sha512,
    gitHead: m.gitHead,
  });
  facts.provenance = found.facts;
  problems.push(...found.problems);
  return undefined;
}

function signatures() {
  const dir = mkdtempSync(join(tmpdir(), 'cert-audit-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
    sh('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `${NAME}@${version}`], {
      cwd: dir,
    });
    let out;
    try {
      out = sh('npm', ['audit', 'signatures'], { cwd: dir });
    } catch (error) {
      out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      problems.push(`npm audit signatures failed: ${one(out).slice(0, 300)}`);
    }
    if (!/verified attestation/.test(out))
      problems.push('npm audit signatures verified no attestation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function onMain() {
  const commit = facts.provenance?.gitCommit;
  if (!commit) return;
  let ref = gh(`repos/${repo}/git/ref/tags/v${version}`).object;
  if (ref.type === 'tag') ref = gh(`repos/${repo}/git/tags/${ref.sha}`).object;
  facts.tagCommit = ref.sha;
  if (ref.sha !== commit) problems.push(`tag v${version} is ${ref.sha}, provenance says ${commit}`);
  const status = gh(`repos/${repo}/compare/main...${commit}`).status;
  if (status !== 'identical' && status !== 'behind')
    problems.push(`${commit} is ${status} of main`);
}

function context(published) {
  const tags = ghAll(`repos/${repo}/tags`).map((t) => t.name);
  facts.covers = covers(version, tags, published);
  const before = published.filter((v) => older(v, version));
  const since = before.reduce((a, v) => (a && !older(a, v) ? a : v), undefined);
  const prs = [];
  if (since) {
    for (const n of mergedPrs(ghAll(`repos/${repo}/compare/v${since}...v${version}`))) {
      const pull = gh(`repos/${repo}/pulls/${n}`);
      const statuses = ghAll(`repos/${repo}/commits/${pull.head.sha}/statuses`);
      const found = statusAt(statuses, ['cert-review', 'cert-review-pr'], pull.merged_at);
      prs.push({
        pr: n,
        head: pull.head.sha,
        behaviour: behaviourFiles(ghAll(`repos/${repo}/pulls/${n}/files`)),
        state: found?.state,
      });
    }
  }
  const group = groupVerdict(prs);
  facts.prCertified =
    group.state === 'success' ? group.line : group.line.replace(/^not certified: /, 'not all: ');
  facts.known = ghAll(`repos/${repo}/issues?labels=known-issue&state=open`)
    .filter((i) => !i.pull_request)
    .map((i) => `${repo}#${i.number}`);
}

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('verify: --version must be x.y.z');
  verdict('verify', false, '--version must be x.y.z');
  process.exit(2);
}
try {
  const published = npmView(NAME, 'versions') ?? [];
  const latest = npmView(NAME, 'dist-tags.latest');
  if (!published.includes(version) && typeof latest === 'string' && older(version, latest)) {
    summary(
      `${NAME}@${version} isn't on npm and npm's latest ${latest} is newer: release-recover skipped it (#837), nothing to verify`
    );
    verdict(
      'verify',
      true,
      `${NAME}@${version}: skipped by release-recover (#837), nothing to verify`
    );
    process.exit(0);
  }
  const m = await meta();
  await download(m);
  if (facts.sha512) {
    await provenance(m);
    signatures();
    onMain();
  }
  context(npmView(NAME, 'versions') ?? published);
} catch (error) {
  problems.push(`check failed: ${one(error.stderr || error.message).slice(0, 300)}`);
}

const ci = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${values.run}`;
if (problems.length) {
  const alert = `supply-chain alert: ${NAME}@${version} on npm doesn't verify: ${problems.join('; ')} (ci: ${ci})`;
  summary(alert);
  console.log(`::error title=verify on npm::${alert}`);
  verdict('verify', false, alert);
  process.exit(1);
}
const line = `certified ${NAME}@${version} sha256=${facts.sha256} (covers ${facts.covers}; ci: ${ci}; pr-certified: ${facts.prCertified}; known: ${facts.known.length ? facts.known.join(', ') : 'none'})`;
summary(line);
const release = gh(`repos/${repo}/releases/tags/v${version}`);
const notes = releaseNotes(release.body, line, { version, sha256: facts.sha256 });
if (notes.conflict) {
  const alert = `supply-chain alert: ${NAME}@${version}: npm serves sha256=${facts.sha256}, but ${notes.conflict} (ci: ${ci})`;
  summary(alert);
  console.log(`::error title=verify on npm::${alert}`);
  verdict('verify', false, alert);
  process.exit(1);
}
if (notes.unchanged) summary(`the release notes of v${version} already carry this line: unchanged`);
else if (values.notes === 'write') {
  const file = join(mkdtempSync(join(tmpdir(), 'cert-notes-')), 'notes.md');
  writeFileSync(file, notes.body);
  sh('gh', ['release', 'edit', `v${version}`, '--repo', repo, '--notes-file', file]);
  summary(`wrote the line into the release notes of v${version}`);
} else
  summary(
    `the release notes of v${version} would get the line (--notes ${values.notes}: not written)`
  );
verdict('verify', true, line);
