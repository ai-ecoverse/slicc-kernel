#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { retryDecision } from './lib.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: 'ai-ecoverse/slicc-kernel' },
    run: { type: 'string' },
    attempt: { type: 'string' },
    sha: { type: 'string' },
  },
});
const { repo, run, attempt, sha } = values;
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const headers = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github+json',
};
async function api(path, init = {}) {
  const r = await fetch(`${API}/${path}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${path}: HTTP ${r.status}`);
  return r.status === 204 || r.status === 201 ? null : r.json();
}
const say = (text) => {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
};

const statuses = await api(`repos/${repo}/commits/${sha}/statuses?per_page=100`);
const state = statuses.find((s) => s.context === 'cert-review')?.state;
let active = 0;
for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
  const r = await api(
    `repos/${repo}/actions/workflows/release.yml/runs?status=${status}&per_page=20`
  );
  active += r.workflow_runs.filter((x) => String(x.id) !== String(run)).length;
}
const d = retryDecision({ attempt, state, active });
say(`${sha} (run ${run}, attempt ${attempt}): ${d.why}`);
if (d.retry) {
  await api(`repos/${repo}/actions/runs/${run}/rerun-failed-jobs`, { method: 'POST' });
  say(`re-running the failed jobs of run ${run}`);
}
