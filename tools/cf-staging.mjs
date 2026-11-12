import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = 'examples/cloudflare-computer/wrangler.json';
const API = 'https://api.cloudflare.com/client/v4';
export const PREFIX = 'slicc-kernel-do-pr-';
export const LIFETIME_MS = 24 * 60 * 60 * 1000;
export const STALE_MS = 7 * 24 * 60 * 60 * 1000;

export function pullRequestOf(ref) {
  const found = /^refs\/pull\/(\d+)\//.exec(ref ?? '');
  return found ? Number(found[1]) : undefined;
}

export function workerName(pr) {
  return `${PREFIX}${pr}`;
}

export function deployedOrigin(output, name) {
  const found = new RegExp(`https://${name}\\.[a-z0-9-]+\\.workers\\.dev`).exec(output);
  return found?.[0];
}

export function staleWorkers(scripts, keep, now = Date.now()) {
  return scripts
    .filter((script) => typeof script.id === 'string' && script.id.startsWith(PREFIX))
    .filter((script) => script.id !== keep)
    .filter((script) => now - Date.parse(script.modified_on) > STALE_MS)
    .map((script) => script.id);
}

export function stagingUrl(origin, key) {
  return `${origin}/?key=${key}`;
}

function wrangler(args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(`${REPO}node_modules/.bin/wrangler`, args, {
      cwd: REPO,
      env: { ...process.env, ...env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', CI: '1' },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`wrangler ${args[0]} exited with ${code}: ${output.slice(-2000)}`));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function retried(work, tries = 3, pauseMs = 5000) {
  for (let left = tries; ; left--) {
    try {
      return await work();
    } catch (error) {
      if (left <= 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }
}

async function api(path, token) {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(`${path}: ${response.status}`);
  return body.result;
}

async function accountOf(token, given) {
  if (given) return given;
  const accounts = await api('/accounts', token);
  return accounts.length === 1 ? accounts[0].id : undefined;
}

async function sweep(token, account, keep, auth) {
  const scripts = await api(`/accounts/${account}/workers/scripts`, token);
  const gone = [];
  for (const name of staleWorkers(scripts, keep)) {
    await wrangler(['delete', '--name', name, '--force'], auth);
    gone.push(name);
  }
  return gone;
}

export async function staging(env = process.env, login = false) {
  const token = env.SLICC_KERNEL_CLOUDFLARE_API_TOKEN;
  if (!token && !login) return { skipped: 'SLICC_KERNEL_CLOUDFLARE_API_TOKEN is not set' };
  const pr = pullRequestOf(env.GITHUB_REF);
  if (pr === undefined) return { skipped: `${env.GITHUB_REF || 'this run'} is not a pull request` };
  if (!existsSync(`${REPO}dist/cloudflare.js`)) return { skipped: 'dist/cloudflare.js is missing' };
  const name = workerName(pr);
  const account = token
    ? await accountOf(token, env.SLICC_KERNEL_CLOUDFLARE_ACCOUNT_ID)
    : env.SLICC_KERNEL_CLOUDFLARE_ACCOUNT_ID;
  const auth = {
    ...(token ? { CLOUDFLARE_API_TOKEN: token } : {}),
    ...(account ? { CLOUDFLARE_ACCOUNT_ID: account } : {}),
  };
  const expires = Date.now() + LIFETIME_MS;
  const deployed = await retried(() =>
    wrangler(['deploy', '--config', CONFIG, '--name', name, '--var', `EXPIRES:${expires}`], auth)
  );
  const origin = deployedOrigin(deployed, name);
  if (!origin) throw new Error(`wrangler deploy printed no workers.dev address for ${name}`);
  const key = randomBytes(24).toString('hex');
  await retried(() =>
    wrangler(['secret', 'put', 'KEY', '--config', CONFIG, '--name', name], auth, key)
  );
  const swept = token && account ? await sweep(token, account, name, auth).catch(() => []) : [];
  return { name, origin, url: stagingUrl(origin, key), expires, swept };
}

async function main() {
  const login = process.argv.includes('--wrangler-login');
  let result;
  try {
    result = await staging(process.env, login);
  } catch (error) {
    result = { skipped: `the deploy failed: ${error.message}` };
    console.error(`::warning title=Staging::${String(error.message).split('\n')[0]}`);
  }
  if (result.skipped) {
    console.log(`No staging Worker: ${result.skipped}.`);
    return;
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${result.url}\n`);
  else console.log(result.url);
  const until = new Date(result.expires).toISOString();
  console.log(`Staging Worker \`${result.name}\` at ${result.origin}, until ${until}.`);
  for (const name of result.swept) console.log(`Deleted the stale staging Worker \`${name}\`.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
