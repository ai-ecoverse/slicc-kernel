#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { NAME, provenanceProblems } from './lib.mjs';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    sha256: { type: 'string', default: '' },
    repo: { type: 'string', default: 'ai-ecoverse/slicc-kernel' },
    wait: { type: 'string', default: '600' },
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
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function meta() {
  const until = Date.now() + Number(values.wait) * 1000;
  for (;;) {
    try {
      const m = JSON.parse(sh('npm', ['view', `${NAME}@${version}`, '--json', '--prefer-online']));
      if (m.version === version && m.dist?.tarball) {
        const head = await fetch(m.dist.tarball, { method: 'HEAD' });
        if (head.ok) return m;
      }
    } catch (error) {
      if (Date.now() > until) throw error;
    }
    if (Date.now() > until) throw new Error(`npm doesn't serve ${NAME}@${version}`);
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
  if (facts.sha256 !== values.sha256.trim())
    problems.push(
      `npm serves sha256 ${facts.sha256}, cert-review certified ${values.sha256 || '(none)'}`
    );
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
    mkdirSync(dir, { recursive: true });
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
    facts.signatures = one(out);
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

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('published: --version must be x.y.z');
  process.exit(2);
}
try {
  const m = await meta();
  facts.gitHead = m.gitHead;
  await download(m);
  if (facts.sha512) {
    await provenance(m);
    signatures();
    onMain();
  }
} catch (error) {
  problems.push(`check failed: ${one(error.stderr || error.message).slice(0, 300)}`);
}
const prov = facts.provenance;
const line = problems.length
  ? `cert-ci: FAIL published ${NAME}@${version}: ${problems.join('; ')}`
  : `verified ${NAME}@${version} sha256=${facts.sha256} on npm: ${facts.integrity}, provenance ${prov.workflow.path}@${prov.workflow.ref} commit ${prov.gitCommit} = gitHead = tag v${version}, on main; ${facts.signatures}`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${line}\n\`\`\`\n`);
process.exit(problems.length ? 1 : 0);
