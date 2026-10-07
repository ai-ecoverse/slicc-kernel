import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const TAG = /^v\d+\.\d+\.\d+$/;
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

const PUBLISHED = /cannot publish over the previously published versions/i;
const CONFIRM = { every: 15000, times: 20 };

async function confirmed(done, sleep) {
  for (let n = 0; n < CONFIRM.times; n++) {
    if (await done()) return true;
    await sleep(CONFIRM.every);
  }
  return done();
}

async function retried({ label, attempt, done, sleep, log, already = () => false }) {
  for (let n = 0; ; n++) {
    const r = await attempt();
    if (r.code === 0) return true;
    if (already(r)) {
      if (await confirmed(done, sleep)) return false;
      throw new Error(
        `${label}: npm refuses it as already published, but the registry does not show it (unpublished?)`
      );
    }
    if (await done()) return false;
    if (n >= DELAYS.length) throw new Error(`${label} failed: ${r.stderr.trim()}`);
    log(`${label} failed, retrying: ${r.stderr.trim().split('\n').pop()}`);
    await sleep(DELAYS[n]);
  }
}

export async function recover({
  name,
  outcome,
  run = exec,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console.log,
}) {
  const listed = await run('git', ['tag', '--points-at', 'HEAD']);
  const tags = listed.stdout
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => TAG.test(t));
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
      else log(`git push ${notes} failed, leaving it: ${r.stderr.trim().split('\n').pop()}`);
    }
    if (!(await published(version))) {
      await run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']);
      const ours = await retried({
        label: `npm publish ${version}`,
        attempt: () => run('npm', ['publish']),
        done: () => published(version),
        already: (r) => PUBLISHED.test(r.stderr),
        sleep,
        log,
      });
      if (ours) recovered.push(`${name}@${version} on npm`);
      else log(`${name}@${version} was already on npm`);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { name } = JSON.parse(await readFile('package.json', 'utf8'));
  await recover({ name, outcome: process.env.RELEASE_OUTCOME }).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
