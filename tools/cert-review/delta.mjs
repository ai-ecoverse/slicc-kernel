#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { deltaFiles, mergedPrs, rowOf } from './lib.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: 'ai-ecoverse/slicc-kernel' },
    prev: { type: 'string' },
    version: { type: 'string' },
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

const pages = gh(`repos/${repo}/compare/v${prev}...v${version}?per_page=250`);
const commits = pages.flatMap((p) => p.commits ?? []);
const rows = [];
for (const n of mergedPrs(commits)) {
  const [pr] = gh(`repos/${repo}/pulls/${n}`);
  const files = gh(`repos/${repo}/pulls/${n}/files?per_page=100`).flat();
  rows.push(rowOf(pr, files));
}
const delta = { repo, prev, version, commits: commits.length, rows, files: deltaFiles(rows) };
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, `${JSON.stringify(delta, null, 2)}\n`);
console.log(
  `delta v${prev}..v${version}: ${commits.length} commits, ${rows.length} pull requests, ${delta.files.length} integration test files`
);
for (const r of rows)
  console.log(
    `#${r.pr} ${r.kind}${r.behaviour ? '' : ' (no behaviour)'}: ${r.title} [${r.tests.map((t) => `${t.file}: ${t.titles.length}`).join(', ')}]`
  );
