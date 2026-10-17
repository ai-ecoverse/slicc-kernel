#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { compatRegressions, missingShards, rerunSet, verdict } from './lib.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: 'ai-ecoverse/slicc-kernel' },
    version: { type: 'string' },
    commit: { type: 'string' },
    out: { type: 'string' },
    wait: { type: 'string', default: '150' },
    dispatch: { type: 'boolean', default: false },
    rerun: { type: 'boolean', default: false },
    reference: { type: 'string', default: '' },
    ref: { type: 'string', default: 'main' },
    run: { type: 'string', default: '' },
    artifact: { type: 'string', default: '' },
    sha256: { type: 'string', default: '' },
    shards: { type: 'string', default: '' },
  },
});
const { repo, version, commit, reference } = values;
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const WORKFLOW = 'kernel-compat.yml';
const { sha256 } = values;
const TITLE = `Kernel compat v${version}${sha256 ? ` ${sha256}` : ''}${reference ? ` ref ${reference}` : ''}`;
const CANDIDATE = {
  ...(sha256 ? { run: values.run, artifact: values.artifact, sha256 } : {}),
  ...(values.shards ? { shards: values.shards } : {}),
};
const headers = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github+json',
};

async function api(path, init = {}) {
  const r = await fetch(path.startsWith('http') ? path : `${API}/${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (!r.ok) {
    throw new Error(
      `${init.method ?? 'GET'} ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`
    );
  }
  return r.status === 204 ? null : r.json();
}

async function text(path) {
  const r = await fetch(`${API}/${path}`, { headers });
  return r.ok ? r.text() : '';
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const USABLE = new Set(['success', 'failure']);

async function jobsOf(run) {
  return (await api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`)).jobs;
}

async function forVersion(run, jobs) {
  if (run.display_title === TITLE) return true;
  const candidate = jobs.find((j) => j.name === 'candidate');
  if (!candidate) return false;
  const log = await text(`repos/${repo}/actions/jobs/${candidate.id}/logs`);
  const line = `@ai-ecoverse/slicc-kernel@${version}${sha256 ? ` sha256=${sha256}` : ''}`;
  return log.includes(`${line}\n`) || log.includes(`${line}\r`);
}

async function candidates(after, strict) {
  const runs = [];
  const d = await api(
    `repos/${repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=50`
  );
  runs.push(
    ...d.workflow_runs.filter(
      (r) => (!strict && r.display_title === TITLE) || (after !== '' && r.created_at >= after)
    )
  );
  return runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function dispatch(given) {
  const inputs = reference ? { ...given, reference } : given;
  const after = new Date(Date.now() - 5000).toISOString().replace(/\.\d+Z$/, 'Z');
  await api(`repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: values.ref, inputs }),
  });
  console.log(`compat: dispatched kernel-compat ${JSON.stringify(inputs)}`);
  return after;
}

async function finished({ set, deadline }) {
  let after = set ? await dispatch({ version, ...CANDIDATE, set }) : '';
  let dispatched = Boolean(set);
  for (;;) {
    let pending = false;
    for (const run of await candidates(after, Boolean(set))) {
      if (run.status !== 'completed') {
        pending = true;
        continue;
      }
      if (!USABLE.has(run.conclusion)) continue;
      const jobs = await jobsOf(run);
      if (!jobs.some((j) => j.name.startsWith('release /') && j.conclusion !== 'skipped')) continue;
      if (!(await forVersion(run, jobs))) continue;
      return { run, jobs, dispatched };
    }
    if (!pending && !dispatched && values.dispatch) {
      after = await dispatch({ version, ...CANDIDATE });
      dispatched = true;
      await sleep(15_000);
      continue;
    }
    if (!pending && !dispatched && !values.dispatch) return { dispatched };
    if (Date.now() > deadline) return { dispatched };
    await sleep(60_000);
  }
}

function artifactsOf(run) {
  return JSON.parse(
    execFileSync('gh', ['api', `repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`], {
      encoding: 'utf8',
    })
  ).artifacts.map((a) => a.name);
}

async function rerunShards(run) {
  await api(`repos/${repo}/actions/runs/${run.id}/rerun-failed-jobs`, { method: 'POST' });
  console.log(`compat: re-running the failed jobs of ${run.html_url}`);
  const deadline = Date.now() + 120 * 60_000;
  await sleep(15_000);
  for (;;) {
    const again = await api(`repos/${repo}/actions/runs/${run.id}`);
    if (again.status === 'completed' && again.run_attempt > run.run_attempt) return again;
    if (Date.now() > deadline) return undefined;
    await sleep(60_000);
  }
}

function report(run) {
  const dir = mkdtempSync(join(tmpdir(), 'compat-'));
  try {
    const names = artifactsOf(run);
    const name = names.find((n) => /^kernel-compat-/.test(n) && !/-(shard-\d+|plan)$/.test(n));
    if (!name) return undefined;
    execFileSync('gh', ['run', 'download', String(run.id), '-R', repo, '-n', name, '-D', dir], {
      stdio: 'inherit',
    });
    const file = join(dir, 'compat.json');
    if (!existsSync(file)) return undefined;
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const logs = join(dir, 'logs');
    const texts = new Map();
    if (existsSync(logs)) {
      for (const f of readdirSync(logs))
        texts.set(`logs/${f}`, readFileSync(join(logs, f), 'utf8').slice(-20000));
    }
    return { name, json, texts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const deadline = Date.now() + Number(values.wait) * 60_000;
async function whole(found) {
  if (!found.run || found.run.conclusion === 'success') return { ...found, shards: [] };
  let { run, jobs } = found;
  let shards = missingShards(jobs, artifactsOf(run));
  let shardRerun;
  if (shards.length > 0 && values.rerun) {
    const again = await rerunShards(run);
    shardRerun = { shards, conclusion: again?.conclusion ?? 'timed out' };
    if (again) {
      run = again;
      jobs = await jobsOf(again);
      shards = missingShards(jobs, artifactsOf(again));
    }
  }
  return { ...found, run, jobs, shards, ...(shardRerun ? { shardRerun } : {}) };
}

const first = await whole(await finished({ deadline }));
const out = {
  version,
  commit,
  sha256: sha256 || undefined,
  dispatched: first.dispatched,
  found: Boolean(first.run),
};
if (first.run && first.run.conclusion !== 'success') out.missingShards = first.shards;
if (first.shardRerun) out.shardRerun = first.shardRerun;
if (first.run) {
  const got = report(first.run);
  Object.assign(out, {
    run: first.run.html_url,
    event: first.run.event,
    conclusion: first.run.conclusion,
    jobs: first.jobs.map((j) => ({ name: j.name, conclusion: j.conclusion })),
    artifact: got?.name,
    reference: got?.json.inputs?.reference || got?.json.reference?.version || null,
    verdict: got?.json.verdict,
    summary: got?.json.summary,
  });
  let regressions = compatRegressions(got?.json);
  if (regressions.length > 0 && values.rerun) {
    const set = rerunSet(regressions);
    const again = await whole(await finished({ set, deadline: Date.now() + 120 * 60_000 }));
    const rerun = again.run ? report(again.run) : undefined;
    out.rerun = again.run
      ? {
          run: again.run.html_url,
          conclusion: again.run.conclusion,
          set,
          ran: [...new Set((rerun?.json.results ?? []).map((r) => `${r.recipe}@${r.version}`))],
          verdict: rerun?.json.verdict,
          ...(again.shards.length ? { missingShards: again.shards } : {}),
          ...(again.shardRerun ? { shardRerun: again.shardRerun } : {}),
        }
      : { run: null, set };
    regressions = compatRegressions(
      got?.json,
      rerun?.json ?? { results: [] },
      (r) => rerun?.texts.get(r.reference?.log ?? '') ?? ''
    );
  }
  out.regressions = regressions;
}
writeFileSync(values.out, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  out.found
    ? `compat: ${out.run} ${out.conclusion} (verdict ${out.verdict}, ${out.regressions.length} regressions${out.rerun ? `, rerun ${out.rerun.run} ${out.rerun.verdict}` : ''})`
    : `compat: no kernel-compat run for v${version} in time`
);
verdict(
  'compat',
  out.found && out.regressions.length === 0,
  out.found
    ? `${out.regressions.length} regressions, verdict ${out.verdict}: evidence in ${values.out}`
    : `no kernel-compat run for v${version} in time: evidence in ${values.out}`
);
