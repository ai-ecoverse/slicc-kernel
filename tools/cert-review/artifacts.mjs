import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { artifactProblems, verdict } from './lib.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    run: { type: 'string' },
    expect: { type: 'string', multiple: true, default: [] },
    prefix: { type: 'string', multiple: true, default: [] },
    out: { type: 'string', default: '' },
  },
});

const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';

async function listed() {
  const out = [];
  let url = `${API}/repos/${values.repo}/actions/runs/${values.run}/artifacts?per_page=100`;
  while (url) {
    const r = await fetch(url, {
      headers: {
        authorization: `Bearer ${process.env.GH_TOKEN}`,
        accept: 'application/vnd.github+json',
      },
    });
    if (!r.ok) throw new Error(`listing the run's artifacts: HTTP ${r.status}`);
    out.push(...((await r.json()).artifacts ?? []));
    url = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') ?? '')?.[1];
  }
  return out;
}

if (!values.repo || !values.run || values.prefix.length === 0) {
  verdict('artifacts', false, 'usage: --repo o/r --run ID --prefix P [--expect name=id@digest]...');
  process.exit(2);
}
let problems;
try {
  problems = artifactProblems(await listed(), values.expect, values.prefix);
} catch (err) {
  problems = [err instanceof Error ? err.message : String(err)];
}
const line = problems.length
  ? `the run's artifacts are not the producers': ${problems.join('; ')}`
  : `every ${values.prefix.join('/')} artifact of the run is the one its producer job uploaded`;
if (values.out)
  writeFileSync(
    values.out,
    `${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`
  );
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
if (problems.length) console.log(`::error title=cert-review artifacts::${line}`);
verdict('artifacts', problems.length === 0, line);
process.exit(problems.length ? 1 : 0);
