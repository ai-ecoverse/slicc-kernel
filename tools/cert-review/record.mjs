#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { knownLine, provenanceProblems } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    review: { type: 'string' },
    out: { type: 'string' },
    run: { type: 'string', default: '' },
    repo: { type: 'string', default: 'ai-ecoverse/slicc-kernel' },
  },
});

const NAME = '@ai-ecoverse/slicc-kernel';
const { version, repo } = values;
const problems = [];
const facts = {};
const one = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();

const sh = (cmd, args) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
const gh = (path) => JSON.parse(sh('gh', ['api', path]));

async function download(meta) {
  const url = new URL(meta.dist.tarball);
  if (url.origin !== 'https://registry.npmjs.org')
    return problems.push(`the tarball is at ${url.origin}`);
  const res = await fetch(url);
  if (!res.ok) return problems.push(`downloading ${url} answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha512 = createHash('sha512').update(bytes);
  facts.integrity = `sha512-${sha512.copy().digest('base64')}`;
  facts.sha512 = sha512.digest('hex');
  facts.sha256 = createHash('sha256').update(bytes).digest('hex');
  facts.gitHead = meta.gitHead;
  if (meta.dist.integrity !== facts.integrity) {
    problems.push(`dist.integrity is ${meta.dist.integrity}, the tarball is ${facts.integrity}`);
  }
  return undefined;
}

async function provenance(meta) {
  const url = meta.dist.attestations?.url;
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
    gitHead: meta.gitHead,
  });
  facts.provenance = found.facts;
  problems.push(...found.problems);
  return undefined;
}

function signatures() {
  const dir = join(process.env.RUNNER_TEMP ?? '/tmp', 'cert-audit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
  sh('npm', [
    'install',
    '--prefix',
    dir,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `${NAME}@${version}`,
  ]);
  let out;
  try {
    out = execFileSync('npm', ['audit', 'signatures'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    problems.push(`npm audit signatures failed: ${one(out).slice(0, 300)}`);
  }
  facts.signatures = one(out);
  if (!/verified attestation/.test(out))
    problems.push('npm audit signatures verified no attestation');
}

function onMain() {
  const commit = facts.provenance?.gitCommit;
  if (!commit) return;
  let ref = gh(`repos/${repo}/git/ref/tags/v${version}`).object;
  if (ref.type === 'tag') ref = gh(`repos/${repo}/git/tags/${ref.sha}`).object;
  facts.tagCommit = ref.sha;
  if (ref.sha !== commit) problems.push(`tag v${version} is ${ref.sha}, provenance says ${commit}`);
  const cmp = gh(`repos/${repo}/compare/main...${commit}`);
  facts.onMain = cmp.status;
  if (cmp.status !== 'identical' && cmp.status !== 'behind')
    problems.push(`${commit} is ${cmp.status} of main`);
  facts.commit = commit;
}

async function supplyChain() {
  const meta = JSON.parse(sh('npm', ['view', `${NAME}@${version}`, '--json']));
  if (meta.name !== NAME || meta.version !== version) {
    return problems.push(`npm view answered ${meta.name}@${meta.version}`);
  }
  await download(meta);
  if (!facts.sha512) return undefined;
  await provenance(meta);
  signatures();
  onMain();
  return undefined;
}

function readVerdict() {
  try {
    const v = JSON.parse(readFileSync(join(values.review, 'verdict.json'), 'utf8'));
    if (v?.verdict !== 'certified' && v?.verdict !== 'fail') {
      problems.push(`verdict.json says "${one(v?.verdict)}", neither certified nor fail`);
      return undefined;
    }
    const known = Array.isArray(v.known) ? v.known : [];
    if (v.known !== undefined && !Array.isArray(v.known))
      problems.push('verdict.json "known" is not a list');
    return {
      verdict: v.verdict,
      known: known.map((k) => one(k).slice(0, 120)).filter(Boolean),
      reason: one(v.reason).slice(0, 300),
    };
  } catch (error) {
    problems.push(`no readable verdict.json (${one(error.message)})`);
    return undefined;
  }
}

function standing() {
  const list = JSON.parse(readFileSync(join(here, 'known.json'), 'utf8')).always ?? [];
  const open = [];
  for (const entry of list) {
    try {
      const [owner, rest] = entry.split('#');
      if (gh(`repos/${owner}/issues/${rest}`).state === 'open') open.push(entry);
    } catch {
      open.push(entry);
    }
  }
  return open;
}

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('record: --version must be x.y.z');
  process.exit(2);
}
try {
  await supplyChain();
} catch (error) {
  problems.push(`supply-chain check failed: ${one(error.stderr || error.message).slice(0, 300)}`);
}
const review = readVerdict();
const known = knownLine(repo, [...standing(), ...(review?.known ?? [])]);
const ci = values.run ? `ci: ${values.run}` : 'ci: local';
let line;
if (problems.length === 0 && review?.verdict === 'certified') {
  line = `certified ${NAME}@${version} sha256=${facts.sha256} (${ci}; known: ${known.length ? known.join(', ') : 'none'})`;
} else {
  const why = [
    ...(review?.verdict === 'fail' ? [`the reviewer: ${review.reason || 'no reason given'}`] : []),
    ...(review?.verdict === 'certified' ? ['the reviewer certified it'] : []),
    ...problems,
  ];
  line = `cert-ci: FAIL ${NAME}@${version}: ${why.join('; ')} (${ci})`;
}
const certified = line.startsWith('certified ');
const comment = existsSync(join(values.review, 'comment.md'))
  ? readFileSync(join(values.review, 'comment.md'), 'utf8').trim()
  : '**Cert review:** the reviewer wrote no comment.';
const prov = facts.provenance;
const checks = [
  `- npm integrity: ${facts.integrity ?? '?'} (sha256 ${facts.sha256 ?? '?'}), computed here from the registry tarball`,
  `- provenance: ${prov ? `${prov.workflow?.path}@${prov.workflow?.ref}, commit ${prov.gitCommit}, builder ${prov.builder}` : '?'}`,
  `- gitHead ${facts.gitHead ?? '?'}, tag v${version} ${facts.tagCommit ?? '?'}, main...commit ${facts.onMain ?? '?'}`,
  `- signatures: ${facts.signatures ?? '?'}`,
].join('\n');
const trouble = problems.length
  ? `\n\n**Problems:**\n${problems.map((p) => `- ${p}`).join('\n')}`
  : '';
const body = `<!-- cert-review -->\n${comment}\n\n**Checked by record, in code:**\n${checks}\n\n\`\`\`\n${line}\n\`\`\`${trouble}\n<!-- /cert-review -->\n`;
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, 'line.txt'), `${line}\n`);
writeFileSync(join(values.out, 'body.md'), body);
writeFileSync(
  join(values.out, 'record.json'),
  `${JSON.stringify({ name: NAME, version, certified, line, commit: facts.commit ?? null, facts, problems, review, known }, null, 2)}\n`
);
console.log(line);
for (const p of problems) console.error(`problem: ${p}`);
process.exit(certified ? 0 : 1);
