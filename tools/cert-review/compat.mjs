#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: 'ai-ecoverse/slicc-kernel' },
    version: { type: 'string' },
    commit: { type: 'string' },
    out: { type: 'string' },
    wait: { type: 'string', default: '150' },
    dispatch: { type: 'boolean', default: false },
  },
});
const { repo, version, commit } = values;
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const WORKFLOW = 'kernel-compat.yml';
const TITLE = `Kernel compat v${version}`;
const headers = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github+json',
};

async function api(path, init = {}) {
  const r = await fetch(path.startsWith('http') ? path : `${API}/${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (!r.ok)
    throw new Error(
      `${init.method ?? 'GET'} ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`
    );
  return r.status === 204 ? null : r.json();
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const USABLE = new Set(['success', 'failure']);

async function candidates() {
  const own = await api(
    `repos/${repo}/actions/workflows/${WORKFLOW}/runs?head_sha=${commit}&event=workflow_run&per_page=20`
  );
  const dispatched = await api(
    `repos/${repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=50`
  );
  const named = dispatched.workflow_runs.filter(
    (r) => r.display_title === TITLE || r.name === TITLE
  );
  return [...own.workflow_runs, ...named].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function checked(run) {
  const { jobs } = await api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
  const ran = jobs.filter((j) => j.name.startsWith('release /') && j.conclusion !== 'skipped');
  return {
    jobs: jobs.map((j) => ({ name: j.name, conclusion: j.conclusion })),
    ran: ran.length > 0,
  };
}

async function verdictFromRelease() {
  try {
    const release = await api(`repos/${repo}/releases/tags/v${version}`);
    const asset = release.assets.find((a) => a.name === `kernel-compat-v${version}.md`);
    if (!asset) return undefined;
    const r = await fetch(asset.browser_download_url);
    const text = await r.text();
    const m = /^- verdict: ([^,\n]+), regressions: ([^\n]+)$/m.exec(text);
    return m
      ? { verdict: m[1].trim(), regressions: m[2].trim(), asset: asset.browser_download_url }
      : undefined;
  } catch {
    return undefined;
  }
}

const deadline = Date.now() + Number(values.wait) * 60_000;
let dispatched = false;
let result;
for (;;) {
  const runs = await candidates();
  let pending = false;
  for (const run of runs) {
    if (run.status !== 'completed') {
      pending = true;
      continue;
    }
    if (!USABLE.has(run.conclusion)) continue;
    const info = await checked(run);
    if (!info.ran) continue;
    result = { run: run.html_url, event: run.event, conclusion: run.conclusion, jobs: info.jobs };
    break;
  }
  if (result) break;
  if (!pending && !dispatched && values.dispatch) {
    await api(`repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref: 'main', inputs: { version } }),
    });
    dispatched = true;
    console.log(`compat: no usable kernel-compat run for v${version}; dispatched one`);
  } else if (!pending && !values.dispatch) {
    break;
  }
  if (Date.now() > deadline) break;
  await sleep(60_000);
}
const verdict = result ? await verdictFromRelease() : undefined;
const compat = {
  version,
  commit,
  dispatched,
  found: Boolean(result),
  ...result,
  ...(verdict ? { report: verdict } : {}),
};
writeFileSync(values.out, `${JSON.stringify(compat, null, 2)}\n`);
console.log(
  result
    ? `compat: ${result.run} ${result.conclusion}${verdict ? ` (verdict ${verdict.verdict}, regressions ${verdict.regressions})` : ''}`
    : `compat: no kernel-compat run for v${version} in time`
);
