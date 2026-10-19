import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [base, candidate] = [process.env.AB_BASE, process.env.AB_CANDIDATE];
const pairs = Number(process.env.AB_PAIRS ?? 3);
const pnpm = process.env.AB_PNPM ?? '';
if (!base || !candidate) {
  console.error('install-ab: set AB_BASE and AB_CANDIDATE to git refs');
  process.exit(2);
}

const here = resolve('.');
const work = resolve(process.env.RUNNER_TEMP ?? '/tmp', 'install-ab');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const sh = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...options });

if (pnpm) {
  sh('npm', ['install', '--no-save', '--no-audit', '--no-fund', `@ai-ecoverse/wasi-pnpm@${pnpm}`]);
}

const builds = {};
for (const [name, ref] of [
  ['A', base],
  ['B', candidate],
]) {
  sh('git', ['fetch', '--quiet', '--depth', '1', 'origin', ref]);
  const sha = sh('git', ['rev-parse', 'FETCH_HEAD']).trim();
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  execFileSync('bash', ['-c', `git archive ${sha} | tar -x -C ${dir}`], { stdio: 'inherit' });
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  symlinkSync(join(here, 'node_modules'), join(dir, 'node_modules'));
  execFileSync('node', ['build.mjs'], { cwd: dir, stdio: 'inherit' });
  builds[name] = { ref, sha, dist: join(dir, 'dist') };
}

const install = (name) => {
  rmSync(join(here, 'dist'), { recursive: true, force: true });
  cpSync(builds[name].dist, join(here, 'dist'), { recursive: true });
  const run = spawnSync(
    'node',
    [
      '--test',
      '--test-timeout=1800000',
      '--test-concurrency=1',
      '--test-global-setup=node_modules/@ai-ecoverse/slicc-shared-web/harness/global.mjs',
      'test/integration/perf/agent-install-page.perf.mjs',
    ],
    { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } }
  );
  const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('| total |'));
  if (run.status !== 0 || !line) {
    console.error(run.stdout?.slice(-3000), run.stderr?.slice(-3000));
    throw new Error(`install-ab: the ${name} install failed`);
  }
  const cells = line.split('|').map((c) => c.trim());
  return {
    wall: Number.parseFloat(cells[2]),
    calls: Number(cells[3]),
    lookups: Number(cells[4]),
    requests: Number(cells[5]),
  };
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const rows = [];
for (let i = 1; i <= pairs; i++) {
  const a = install('A');
  const b = install('B');
  rows.push({ i, a, b, ratio: b.wall / a.wall, requests: b.requests / a.requests });
  console.log(`pair ${i}: A ${a.wall} s, B ${b.wall} s, ratio ${(b.wall / a.wall).toFixed(3)}`);
}

const ratios = rows.map((r) => r.ratio);
const table = [
  `### Install A/B on one runner: A ${builds.A.ref} (${builds.A.sha.slice(0, 8)}), B ${builds.B.ref} (${builds.B.sha.slice(0, 8)})${pnpm ? `, wasi-pnpm ${pnpm}` : ''}`,
  '',
  '| pair | A wall | B wall | B/A wall | A requests | B requests | B/A requests | A calls | B calls |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.i} | ${r.a.wall} s | ${r.b.wall} s | ${r.ratio.toFixed(3)} | ${r.a.requests} | ${r.b.requests} | ${r.requests.toFixed(3)} | ${r.a.calls} | ${r.b.calls} |`
  ),
  `| **median** | ${median(rows.map((r) => r.a.wall))} s | ${median(rows.map((r) => r.b.wall))} s | **${median(ratios).toFixed(3)}** | | | **${median(rows.map((r) => r.requests)).toFixed(3)}** | | |`,
  '',
  `Pair ratio spread: ${Math.min(...ratios).toFixed(3)}–${Math.max(...ratios).toFixed(3)}.`,
  '',
].join('\n');
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
console.log(`install-ab: PASS median wall ratio ${median(ratios).toFixed(3)} over ${pairs} pairs`);
