#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  baseEvidence,
  gapsOf,
  jobsEvidence,
  knownAsOf,
  knownLine,
  NAME,
  packageProblems,
  releaseEvidence,
  verdictLine,
} from './lib.mjs';
import { manifestOf, sha, sri } from './tarball.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    review: { type: 'string' },
    out: { type: 'string' },
    run: { type: 'string', default: '' },
    repo: { type: 'string', default: 'ai-ecoverse/slicc-kernel' },
    planted: { type: 'string', default: '' },
    commit: { type: 'string', default: '' },
    findings: { type: 'string', default: '' },
    covers: { type: 'string', default: '' },
    tarball: { type: 'string', default: '' },
    sha256: { type: 'string', default: '' },
    'review-result': { type: 'string', default: 'success' },
    jobs: { type: 'string', default: '' },
  },
});

const { version, repo, planted } = values;
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

function onMain(commit) {
  const cmp = gh(`repos/${repo}/compare/main...${commit}`);
  facts.onMain = cmp.status;
  if (cmp.status !== 'identical' && cmp.status !== 'behind')
    problems.push(`${commit} is ${cmp.status} of main`);
}

function artifact() {
  const tgz = values.tarball;
  if (!tgz || !existsSync(tgz)) return problems.push('no tarball artifact to review');
  facts.sha256 = sha('sha256', tgz);
  facts.integrity = sri(tgz);
  const packed = values.sha256.trim();
  if (facts.sha256 !== packed)
    problems.push(
      `the artifact's sha256 ${facts.sha256} is not the pack job's ${packed || '(none)'}`
    );
  const manifest = manifestOf(tgz);
  facts.gitHead = manifest.gitHead;
  problems.push(...packageProblems(manifest, { version, commit: values.commit }));
  facts.commit = values.commit;
  if (!planted) onMain(values.commit);
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
      elsewhere: elsewhereOf(v),
      verdict: v.verdict,
      known: known.map((k) => one(k).slice(0, 120)).filter(Boolean),
      reason: one(v.reason).slice(0, 300),
    };
  } catch (error) {
    problems.push(`no readable verdict.json (${one(error.message)})`);
    return undefined;
  }
}

const ISSUE = `query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { issue(number: $n) {
  state stateReason closedAt
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { merged mergeCommit { oid } repository { nameWithOwner } } }
} } }`;

function issueOf(entry) {
  const [full, number] = entry.split('#');
  const [o, r] = full.split('/');
  const out = sh('gh', [
    'api',
    'graphql',
    '-f',
    `query=${ISSUE}`,
    '-F',
    `o=${o}`,
    '-F',
    `r=${r}`,
    '-F',
    `n=${number}`,
  ]);
  const issue = JSON.parse(out).data.repository.issue;
  const closedBy = issue.closedByPullRequestsReferences.nodes
    .filter((pr) => pr.repository.nameWithOwner === full)
    .map((pr) => ({ merged: pr.merged, mergeCommit: pr.mergeCommit?.oid }));
  return {
    state: issue.state,
    stateReason: issue.stateReason,
    closedAt: issue.closedAt,
    closedBy,
    local: full === repo,
  };
}

function ancestorOfRelease(oid) {
  const commit = values.commit || facts.commit;
  if (!commit) return false;
  const status = gh(`repos/${repo}/compare/${oid}...${commit}`).status;
  return status === 'ahead' || status === 'identical';
}

function standing() {
  const known = JSON.parse(readFileSync(join(here, 'known.json'), 'utf8'));
  const listed = known.always ?? [];
  const commit = values.commit || facts.commit;
  const releasedAt = commit
    ? gh(`repos/${repo}/commits/${commit}`).commit.committer.date
    : undefined;
  const labelled = JSON.parse(
    sh('gh', [
      'api',
      '--paginate',
      '--slurp',
      `repos/${repo}/issues?labels=known-issue&state=all&per_page=100`,
    ])
  )
    .flat()
    .filter((i) => !i.pull_request)
    .map((i) => `${repo}#${i.number}`);
  const out = [];
  for (const entry of [...new Set([...labelled, ...listed])]) {
    try {
      const issue = issueOf(entry);
      const fixedIn = known.fixedIn?.[entry];
      const applies =
        issue.local || fixedIn
          ? knownAsOf(issue, { fixedBefore: ancestorOfRelease, releasedAt, version, fixedIn })
          : issue.state === 'OPEN';
      if (applies) out.push(entry);
    } catch (error) {
      problems.push(
        `the known issue ${entry} couldn't be read: ${one(error.stderr || error.message).slice(0, 200)}`
      );
    }
  }
  facts.knownAsOf = out;
  return out.sort((a, b) => Number(a.split('#')[1]) - Number(b.split('#')[1]));
}

let gaps = [];
let baseNote = '';
let incomplete;

function codedFindings() {
  if (!values.findings || !existsSync(values.findings)) return;
  const found = JSON.parse(readFileSync(values.findings, 'utf8')).findings ?? [];
  gaps = gapsOf(found);
  incomplete = releaseEvidence(found);
  const partial = baseEvidence(found);
  baseNote = partial.note;
  if (partial.problem) problems.push(partial.problem);
  for (const f of found.filter((x) => x.kind === 'compat-crash')) {
    problems.push(
      `kernel-compat: ${f.package} ${f.spec} crashes again on the rerun and not on the reference kernel`
    );
  }
}

function elsewhereOf(v) {
  const list = Array.isArray(v?.elsewhere) ? v.elsewhere : [];
  return list
    .filter((e) => e && typeof e === 'object' && /^[\w.-]+\/[\w.-]+$/.test(String(e.repo ?? '')))
    .slice(0, 20)
    .map((e) => ({
      repo: String(e.repo),
      title: one(e.title).slice(0, 200),
      body: String(e.body ?? '').slice(0, 4000),
    }));
}

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('record: --version must be x.y.z');
  process.exit(2);
}
if (planted) problems.push(`a planted build of ${planted}: never certified`);
try {
  artifact();
} catch (error) {
  problems.push(`the artifact check failed: ${one(error.stderr || error.message).slice(0, 300)}`);
}
codedFindings();
incomplete = jobsEvidence(`${values.jobs},review=${values['review-result']}`, incomplete);
const review = readVerdict();
const known = knownLine(repo, [...standing(), ...(review?.known ?? [])]);
const covered = values.covers.split(',').filter(Boolean);
const covers = covered.length > 1 ? `covers ${covered[0]}\u2013${covered.at(-1)}; ` : '';
const ci = `${covers}${values.run ? `ci: ${values.run}` : 'ci: local'}`;
const gap = gaps.length ? `; test gaps: ${gaps.join(', ')}` : '';
const partial = baseNote ? `; ${baseNote}` : '';
const { line, state } = verdictLine({
  name: NAME,
  version,
  planted,
  ci,
  problems,
  review,
  incomplete,
  certified: `certified ${NAME}@${version} sha256=${facts.sha256} (${ci}; known: ${known.length ? known.join(', ') : 'none'}${gap}${partial})`,
});
const certified = state === 'success';
const comment = existsSync(join(values.review, 'comment.md'))
  ? readFileSync(join(values.review, 'comment.md'), 'utf8').trim()
  : '**Cert review:** the reviewer wrote no comment.';
const checks = [
  `- the reviewed tarball: sha256 ${facts.sha256 ?? '?'} (${facts.integrity ?? '?'}), re-hashed here from the artifact; the pack job said ${values.sha256 || '?'}`,
  `- gitHead ${facts.gitHead ?? '?'}, tag v${version} ${values.commit || '?'}, main...commit ${facts.onMain ?? '?'}`,
  '- provenance, npm integrity and signatures are checked after publishing, by the release workflow',
].join('\n');
const elsewhere = review?.elsewhere?.length
  ? `\n\n**For the cert lane to file elsewhere:**\n${review.elsewhere.map((e) => `- ${e.repo}: ${e.title}\n\n${e.body.replace(/^/gm, '  > ')}`).join('\n')}`
  : '';
const trouble = problems.length
  ? `\n\n**Problems:**\n${problems.map((p) => `- ${p}`).join('\n')}`
  : '';
const body = `<!-- cert-review -->\n${comment}\n\n**Checked by record, in code:**\n${checks}\n\n\`\`\`\n${line}\n\`\`\`${elsewhere}${trouble}\n<!-- /cert-review -->\n`;
mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, 'line.txt'), `${line}\n`);
writeFileSync(join(values.out, 'body.md'), body);
writeFileSync(
  join(values.out, 'record.json'),
  `${JSON.stringify({ name: NAME, version, certified, state, line, sha256: facts.sha256 ?? null, planted: planted || null, commit: facts.commit ?? null, facts, problems, review, known }, null, 2)}\n`
);
console.log(line);
for (const p of problems) console.error(`problem: ${p}`);
process.exit(certified ? 0 : 1);
