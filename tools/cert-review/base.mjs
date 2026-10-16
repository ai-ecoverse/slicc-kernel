#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareVersions } from './lib.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: 'ai-ecoverse/slicc-kernel' },
    version: { type: 'string' },
    limit: { type: 'string', default: '40' },
  },
});
const here = dirname(fileURLToPath(import.meta.url));
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const headers = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github+json',
};
const SEMVER = /^\d+\.\d+\.\d+$/;

const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
  .split('\n')
  .map((t) => t.replace(/^v/, ''))
  .filter((v) => SEMVER.test(v) && compareVersions(v, values.version) < 0)
  .sort(compareVersions)
  .reverse()
  .slice(0, Number(values.limit));

for (const tag of tags) {
  const commit = execFileSync('git', ['rev-parse', `v${tag}^{commit}`], {
    encoding: 'utf8',
  }).trim();
  const r = await fetch(`${API}/repos/${values.repo}/commits/${commit}/statuses?per_page=100`, {
    headers,
  });
  if (!r.ok) continue;
  const latest = (await r.json()).find((s) => s.context === 'cert-review');
  if (latest?.state === 'success') {
    console.error(`base: v${tag} has a successful cert-review status`);
    console.log(tag);
    process.exit(0);
  }
}
const fallback = JSON.parse(readFileSync(join(here, 'base.json'), 'utf8'));
if (!SEMVER.test(fallback.version) || compareVersions(fallback.version, values.version) >= 0) {
  console.error(`base: base.json names ${fallback.version}, not before ${values.version}`);
  process.exit(1);
}
console.error(
  `base: no earlier cert-review success; base.json names v${fallback.version} (${fallback.line})`
);
console.log(fallback.version);
