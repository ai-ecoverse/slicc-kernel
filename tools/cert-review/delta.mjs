#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import {
  baselineFiles,
  compareVersions,
  deltaFiles,
  mergedPrs,
  rowOf,
  verdict,
  withBaselines,
} from './lib.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: 'ai-ecoverse/slicc-kernel' },
    prev: { type: 'string' },
    version: { type: 'string' },
    head: { type: 'string', default: '' },
    pr: { type: 'string', default: '' },
    only: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});
const { repo, prev, version } = values;

const gh = (path) =>
  JSON.parse(
    execFileSync('gh', ['api', '--paginate', '--slurp', path], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
  );

const head = values.head || `v${version}`;
const commits = values.only
  ? []
  : gh(`repos/${repo}/compare/v${prev}...${head}?per_page=250`).flatMap((p) => p.commits ?? []);
const extra = values.pr ? values.pr.split(',').map(Number) : [];
const rows = [];
for (const n of [...new Set([...mergedPrs(commits), ...extra])]) {
  const [pr] = gh(`repos/${repo}/pulls/${n}`);
  const files = gh(`repos/${repo}/pulls/${n}/files?per_page=100`).flat();
  rows.push(rowOf(pr, files));
}
function published() {
  try {
    return new Set(
      JSON.parse(
        execFileSync('npm', ['view', '@ai-ecoverse/slicc-kernel', 'versions', '--json'], {
          encoding: 'utf8',
        })
      )
    );
  } catch {
    return new Set();
  }
}

const onNpm = values.only ? new Set() : published();
const tags = (values.only ? [] : gh(`repos/${repo}/git/matching-refs/tags/v`).flat())
  .filter((ref) => ref.object.type === 'commit')
  .map((ref) => ({ version: ref.ref.replace(/^refs\/tags\/v/, ''), sha: ref.object.sha }))
  .filter(
    (t) =>
      /^\d+\.\d+\.\d+$/.test(t.version) &&
      onNpm.has(t.version) &&
      compareVersions(t.version, prev) > 0 &&
      compareVersions(t.version, version) < 0
  );
const placed = withBaselines(rows, { commits, tags, prev });
const delta = {
  repo,
  prev,
  version,
  head,
  commits: commits.length,
  rows: placed,
  files: deltaFiles(placed),
  baselines: baselineFiles(placed, prev),
};
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, `${JSON.stringify(delta, null, 2)}\n`);
console.log(
  `delta v${prev}..v${version}: ${commits.length} commits, ${rows.length} pull requests, ${delta.files.length} integration test files`
);
for (const r of placed)
  console.log(
    `#${r.pr} ${r.kind}${r.behaviour ? '' : ' (no behaviour)'}${r.kind === 'fix' && r.baseline !== prev ? ` (NEGATIVE on v${r.baseline})` : ''}: ${r.title} [${r.tests.map((t) => `${t.file}: ${t.titles.length}`).join(', ')}]`
  );
verdict(
  'delta',
  true,
  `${rows.length} pull requests, ${delta.files.length} integration test files`
);
