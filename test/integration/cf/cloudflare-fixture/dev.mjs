import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function startDev(config, { timeoutMs = 90_000, remote } = {}) {
  if (remote?.url && remote?.key) return { url: remote.url, key: remote.key, stop: async () => {} };
  if (!existsSync(join(REPO, 'dist/cloudflare.js'))) {
    return { skip: 'dist/cloudflare.js is missing; run npm run build first' };
  }
  if (!existsSync(join(REPO, 'node_modules/.bin/wrangler'))) {
    return { skip: 'wrangler is not installed; run npm install' };
  }
  const dir = await mkdtemp(join(tmpdir(), 'slicc-cf-'));
  const port = await freePort();
  const inspector = await freePort();
  const key = crypto.randomUUID();
  const child = spawn(
    join(REPO, 'node_modules/.bin/wrangler'),
    [
      'dev',
      '--config',
      config,
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      String(inspector),
      '--persist-to',
      join(dir, 'state'),
      '--var',
      `KEY:${key}`,
      '--show-interactive-dev-session=false',
    ],
    {
      cwd: dirname(config),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', CI: '1' },
    }
  );
  let log = '';
  const gather = (chunk) => {
    log += chunk.toString();
  };
  child.stdout.on('data', gather);
  child.stderr.on('data', gather);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const stop = async () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, 5000);
    await exited;
    clearTimeout(timer);
    await rm(dir, { recursive: true, force: true });
  };
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let ended = false;
  void exited.then(() => {
    ended = true;
  });
  while (Date.now() < deadline && !ended) {
    if (log.includes('Ready on')) {
      try {
        await fetch(url, { headers: { 'x-slicc-key': key } });
        return { url, key, stop, log: () => log };
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await stop();
  return { skip: `wrangler dev did not start:\n${log.split('\n').slice(-20).join('\n')}` };
}

export function client({ url, key }, scope = crypto.randomUUID()) {
  return async (path, body, { raw, query = '' } = {}) => {
    const joined = `${query}${query ? '&' : '?'}do=${scope}`;
    const response = await fetch(`${url}${path}${joined}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-slicc-key': key },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    try {
      return { status: response.status, ...JSON.parse(text) };
    } catch {
      return { status: response.status, text };
    }
  };
}

export async function until(check, { timeoutMs = 20_000, everyMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
