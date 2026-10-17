#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  behaviourFiles,
  groupVerdict,
  manifestOnly,
  mergedPrs,
  reviewsItself,
  verdict,
} from './lib.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string', default: 'ai-ecoverse/slicc-kernel' },
    pr: { type: 'string', default: '' },
    head: { type: 'string', default: '' },
    action: { type: 'string', default: '' },
    label: { type: 'string', default: '' },
    labels: { type: 'string', default: '' },
    base: { type: 'string', default: '' },
    run: { type: 'string', default: '' },
    context: { type: 'string', default: 'cert-review' },
    guard: { type: 'string', default: '' },
    approval: { type: 'string', default: 'cert-review-approved' },
    evidence: { type: 'string', default: '' },
  },
});
const { repo, context } = values;
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const headers = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github+json',
};
const RUN_URL = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${values.run}`;

async function request(url, init = {}) {
  const r = await fetch(url.startsWith('http') ? url : `${API}/${url}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${url}: HTTP ${r.status}`);
  return r;
}

async function all(path) {
  const out = [];
  let url = `${API}/${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  while (url) {
    const r = await request(url);
    const page = await r.json();
    out.push(...(Array.isArray(page) ? page : (page.commits ?? [])));
    url = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') ?? '')?.[1];
  }
  return out;
}

const output = (pairs) => {
  const text = Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  console.log(text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${text}\n`);
  return pairs;
};
const summary = (text) => {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
};

async function status(sha, state, description) {
  await request(`repos/${repo}/statuses/${sha}`, {
    method: 'POST',
    body: JSON.stringify({
      state,
      context,
      target_url: RUN_URL,
      description: description.slice(0, 140),
    }),
  });
  console.log(`${context} ${state} on ${sha}: ${description}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'posted=true\n');
}

const GUARD_FAIL = (label) => `reviewer change: needs coordinator review (${label} on this head)`;
const GUARD_INCOMPLETE = 'the certification self-guard did not finish: re-run the failed jobs';

async function plan() {
  const { action, label, approval } = values;
  const starts =
    action === 'labeled' ? ['merge-ok', approval] : action === 'unlabeled' ? [approval] : [];
  if (
    action === 'ready_for_review' ||
    ((action === 'labeled' || action === 'unlabeled') && !starts.includes(label))
  ) {
    summary(`#${values.pr}: ${action} ${label} doesn't start or change a review`);
    return output({ go: 'false', behaviour: '', self: 'false' });
  }
  const files = await all(`repos/${repo}/pulls/${values.pr}/files`);
  const behaviour = behaviourFiles(files);
  const labelled = values.labels.split(',').includes('merge-ok');
  const self = reviewsItself(files);
  if (values.guard !== 'PASS') {
    const fail = values.guard === 'FAIL';
    await status(
      values.head,
      fail ? 'failure' : 'error',
      fail ? GUARD_FAIL(approval) : GUARD_INCOMPLETE
    );
    summary(
      `#${values.pr}: the certification self-guard says ${values.guard || 'nothing'}: not reviewed`
    );
    return output({ go: 'false', behaviour: behaviour.join(','), self: String(self) });
  }
  if (label === approval && !self) {
    summary(`#${values.pr} doesn't change the reviewer: ${action} ${label} changes nothing`);
    return output({ go: 'false', behaviour: behaviour.join(','), self: 'false' });
  }
  if (behaviour.length === 0) {
    await status(
      values.head,
      'success',
      `not behaviour: ${files.map((f) => f.filename).join(', ')}`
    );
    summary(`#${values.pr} changes no shipped behaviour: not reviewed, cert-review success`);
    return output({ go: 'false', behaviour: '', self: 'false' });
  }
  if (!labelled) {
    await status(
      values.head,
      'failure',
      `waits for merge-ok to be reviewed (changes ${behaviour.slice(0, 4).join(', ')})`
    );
    summary(`#${values.pr} changes shipped behaviour and has no merge-ok yet: not reviewed`);
    return output({ go: 'false', behaviour: behaviour.join(','), self: String(self) });
  }
  await status(values.head, 'pending', `reviewing #${values.pr} at ${values.head.slice(0, 12)}`);
  return output({
    go: 'true',
    behaviour: behaviour.join(','),
    self: String(self),
    manifest: String(manifestOnly(files)),
  });
}

async function lookup() {
  if (values.guard !== 'PASS') {
    const fail = values.guard === 'FAIL';
    const line = fail
      ? `not certified: a pull request in the group changes the reviewer without ${values.approval} on its head`
      : GUARD_INCOMPLETE;
    await status(values.head, fail ? 'failure' : 'error', line);
    console.log(`::error title=not certified::${line}`);
    verdict('pr lookup', false, line);
    process.exit(1);
  }
  const commits = await all(`repos/${repo}/compare/${values.base}...${values.head}`);
  const prs = [];
  for (const n of mergedPrs(commits)) {
    const pull = await (await request(`repos/${repo}/pulls/${n}`)).json();
    const files = await all(`repos/${repo}/pulls/${n}/files`);
    const statuses = await all(`repos/${repo}/commits/${pull.head.sha}/statuses`);
    const found = statuses.find((s) => s.context === context);
    prs.push({
      pr: n,
      head: pull.head.sha,
      behaviour: behaviourFiles(files),
      state: found?.state,
      description: found?.description,
    });
  }
  const group = groupVerdict(prs);
  for (const l of group.lines) summary(`- ${l}`);
  await status(values.head, group.state, group.line);
  if (group.state !== 'success') {
    console.log(`::error title=not certified::${group.line}`);
    verdict('pr lookup', false, group.line);
    process.exit(1);
  }
  verdict('pr lookup', true, group.line);
}

async function same() {
  const evidence = JSON.parse(readFileSync(values.evidence, 'utf8'));
  if (!evidence.identical) {
    summary(`#${values.pr}: ${evidence.line}: the full review goes on`);
    return verdict('pr same', true, `the dist differs: the full review goes on`);
  }
  await status(values.head, 'success', evidence.line);
  summary(
    `#${values.pr} is not reviewed, by the rule ${evidence.rule}. Candidate ${evidence.candidate.version} sha256 ${evidence.candidate.sha256}, base ${evidence.base.version} sha256 ${evidence.base.sha256}.`
  );
  return verdict('pr same', true, evidence.line);
}

if (positionals[0] === 'plan') {
  const { go, behaviour } = await plan();
  verdict('pr plan', true, `go=${go}${behaviour ? ` (behaviour: ${behaviour})` : ''}`);
} else if (positionals[0] === 'same') await same();
else if (positionals[0] === 'lookup') await lookup();
else {
  console.error('pr.mjs plan|lookup|same');
  verdict(`pr ${positionals[0] ?? ''}`.trim(), false, 'usage: pr.mjs plan|lookup|same');
  process.exit(2);
}
