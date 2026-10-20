import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const TAG = /^v\d+\.\d+\.\d+$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

export function olderThan(version, latest) {
  const a = version.split('.').map(Number);
  const b = latest.split('.').map(Number);
  return (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) < 0;
}
const DELAYS = [15000, 30000, 60000];

export function exec(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: String(err) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function gist(stderr) {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/A complete log of this run/.test(l));
  const errors = lines.filter((l) => /^npm (error|ERR!)/.test(l));
  return (errors.length > 0 ? errors : lines).slice(0, 2).join(' | ') || stderr.trim();
}

const PUBLISHED = /cannot publish over (the )?previously (published|staged) version/i;

async function retried({ label, attempt, done, sleep, log, already = () => false }) {
  for (let n = 0; ; n++) {
    const r = await attempt();
    if (r.code === 0) return true;
    if (already(r)) return false;
    if (await done()) return false;
    if (n >= DELAYS.length) throw new Error(`${label} failed: ${r.stderr.trim()}`);
    log(`${label} failed, retrying: ${gist(r.stderr)}`);
    await sleep(DELAYS[n]);
  }
}

async function latestOf(name, version, run) {
  const view = await run('npm', ['view', name, 'dist-tags.latest', '--prefer-online']);
  const latest = view.stdout.trim();
  if (view.code !== 0)
    throw new Error(
      `npm view ${name} dist-tags.latest failed (${gist(view.stderr)}), so ${version} isn't published: re-run the job`
    );
  if (!SEMVER.test(latest))
    throw new Error(
      `npm's latest for ${name} reads as "${latest}", so ${version} isn't published: re-run the job`
    );
  return latest;
}

async function publishNewer({ name, version, run, published, sleep, log }) {
  const latest = await latestOf(name, version, run);
  if (olderThan(version, latest)) {
    log(
      `${name}@${version} is older than npm's latest ${latest}: not published, so latest doesn't move back (${latest} carries its changes)`
    );
    return false;
  }
  await run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']);
  const ours = await retried({
    label: `npm publish ${version}`,
    attempt: async () => {
      const r = await run('npm', ['publish', '--provenance']);
      log(`npm publish ${version} exited ${r.code}`);
      for (const [stream, text] of [
        ['stdout', r.stdout],
        ['stderr', r.stderr],
      ]) {
        if (text.trim()) log(`npm publish ${stream}:\n${text.trimEnd()}`);
      }
      return r;
    },
    done: () => published(version),
    already: (r) => PUBLISHED.test(r.stderr),
    sleep,
    log,
  });
  if (!ours) log(`${name}@${version} was already on npm`);
  return ours;
}

export async function recover({
  name,
  outcome,
  prior = [],
  run = exec,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
}) {
  const listed = await run('git', ['tag', '--points-at', 'HEAD']);
  const tags = listed.stdout
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => TAG.test(t))
    .filter((t) => {
      if (outcome !== 'success' || prior.includes(t)) return true;
      log(`semantic-release just released ${t}, nothing to recover`);
      return false;
    });
  const published = async (version) => {
    const r = await run('npm', ['view', `${name}@${version}`, 'version', '--prefer-online']);
    return r.code === 0 && r.stdout.trim() === version;
  };
  const remote = async (ref) =>
    (await run('git', ['ls-remote', '--exit-code', 'origin', ref])).code === 0;
  const recovered = [];
  for (const tag of tags) {
    const version = tag.slice(1);
    const ref = `refs/tags/${tag}`;
    if (!(await remote(ref))) {
      const pushed = await retried({
        label: `git push ${ref}`,
        attempt: () => run('git', ['push', 'origin', ref]),
        done: () => remote(ref),
        sleep,
        log,
      });
      if (pushed) recovered.push(`tag ${tag} on origin`);
      else log(`tag ${tag} was already on origin`);
    }
    const notes = `refs/notes/semantic-release-${tag}`;
    const local = (await run('git', ['show-ref', '--verify', '--quiet', notes])).code === 0;
    if (local && !(await remote(notes))) {
      const r = await run('git', ['push', 'origin', notes]);
      if (r.code === 0) recovered.push(`notes ${tag} on origin`);
      else log(`git push ${notes} failed, leaving it: ${gist(r.stderr)}`);
    }
    if (!(await published(version))) {
      const ours = await publishNewer({ name, version, run, published, sleep, log });
      if (ours) recovered.push(`${name}@${version} on npm`);
    }
    if ((await run('gh', ['release', 'view', tag])).code !== 0) {
      const r = await run('gh', [
        'release',
        'create',
        tag,
        '--verify-tag',
        '--generate-notes',
        '--title',
        tag,
      ]);
      if (r.code !== 0) throw new Error(`gh release create ${tag} failed: ${r.stderr.trim()}`);
      recovered.push(`GitHub release ${tag}`);
    }
  }
  for (const line of recovered) log(`recovered ${line}`);
  if (outcome === 'failure' && recovered.length === 0) {
    throw new Error('semantic-release failed, and no version tagged at HEAD was left to complete');
  }
  return recovered;
}

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export const VERDICT = 'release-recover:';

export function verdictOf(recovered, error) {
  if (error) return `${VERDICT} FAIL ${String(error.message ?? error).split('\n')[0]}`;
  return recovered.length
    ? `${VERDICT} PASS recovered ${recovered.join(', ')}`
    : `${VERDICT} PASS nothing to recover`;
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  try {
    const { name } = JSON.parse(await readFile('package.json', 'utf8'));
    const prior = (process.env.RELEASE_PRIOR_TAGS ?? '').split(/\s+/).filter(Boolean);
    const recovered = await recover({ name, outcome: process.env.RELEASE_OUTCOME, prior });
    console.log(verdictOf(recovered));
  } catch (err) {
    console.error(err.message);
    console.log(verdictOf([], err));
    process.exitCode = 1;
  }
}
