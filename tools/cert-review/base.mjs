#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareVersions, covering, pickRelease } from './lib.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: 'ai-ecoverse/slicc-kernel' },
    version: { type: 'string' },
    pending: { type: 'boolean', default: false },
    covers: { type: 'string', default: '' },
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
const fallback = JSON.parse(readFileSync(join(here, 'base.json'), 'utf8'));

const all = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
  .split('\n')
  .map((t) => t.replace(/^v/, ''))
  .filter((v) => SEMVER.test(v));
if (values.covers) {
  console.log(covering(all, values.covers, values.version).join(','));
  process.exit(0);
}

const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
  .split('\n')
  .map((t) => t.replace(/^v/, ''))
  .filter((v) => SEMVER.test(v) && compareVersions(v, values.version) < 0)
  .sort(compareVersions)
  .slice(-Number(values.limit));

async function stateOf(tag) {
  const commit = execFileSync('git', ['rev-parse', `v${tag}^{commit}`], {
    encoding: 'utf8',
  }).trim();
  const r = await fetch(`${API}/repos/${values.repo}/commits/${commit}/statuses?per_page=100`, {
    headers,
  });
  if (!r.ok) return undefined;
  return (await r.json()).find((s) => s.context === 'cert-review')?.state;
}

const found = await pickRelease(tags, values.version, stateOf, { pending: values.pending });
if (found) {
  console.error(
    `base: v${found} has a ${values.pending ? 'successful or pending' : 'successful'} cert-review status`
  );
  console.log(found);
  process.exit(0);
}
if (!SEMVER.test(fallback.version) || compareVersions(fallback.version, values.version) >= 0) {
  console.error(`base: base.json names ${fallback.version}, not before ${values.version}`);
  process.exit(1);
}
console.error(
  `base: no earlier cert-review success; base.json names v${fallback.version} (${fallback.line})`
);
console.log(fallback.version);
