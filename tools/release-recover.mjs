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
    const r = await run('npm', ['view', `${name}@${version}`, 'version']);
    return r.code === 0 && r.stdout.trim() === version;
  };
  const recovered = [];
  for (const tag of tags) {
    const version = tag.slice(1);
    if (!(await published(version))) {
      await run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']);
      let done = false;
      for (let attempt = 0; !done; attempt++) {
        const r = await run('npm', ['publish']);
        done = r.code === 0 || (await published(version));
        if (done) break;
        if (attempt >= DELAYS.length)
          throw new Error(`npm publish ${version} failed: ${r.stderr.trim()}`);
        log(`npm publish ${version} failed, retrying: ${r.stderr.trim().split('\n').pop()}`);
        await sleep(DELAYS[attempt]);
      }
      recovered.push(`${name}@${version} on npm`);
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
