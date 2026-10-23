import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { agentRegistry } from './agent-registry.mjs';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';

const AGENT = new URL('./fixtures/agent-install/', import.meta.url);
const CALLS_MAX = 48_000;
const REQUESTS_MAX = 235_000;

const chrome = await launch();
after(() => chrome.close());
before(() => agentRegistry());

const counters = async (bash) =>
  (
    await bash(
      'cat /proc/sys/kernel/slicc_fs_calls /proc/sys/kernel/slicc_opfs_calls /proc/sys/kernel/slicc_opfs_ops',
      { cwd: '/' }
    )
  ).stdout
    .trim()
    .split('\n')
    .map(Number);

test(`a serial offline agent install stays within ${CALLS_MAX} calls and ${REQUESTS_MAX} OPFS requests, CI samples after #1425`, {
  timeout: 960_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t, { users: 'enforce', registry: true });
  for (const name of ['wasm-coreutils', 'wasm-tls-engine', 'wasi-pnpm'])
    await installPackage(page, name);
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const text = await readFile(new URL(file, AGENT), 'utf8');
    await page.evaluate((n, x) => window.opfs.write(`opt/agent/${n}`, x), file, text);
  }
  await page.evaluate(
    (x) => window.opfs.write('opt/agent/.npmrc', x),
    'registry=http://registry.test/\n'
  );
  const start = await counters(bash);
  const t0 = Date.now();
  await bash(
    '(cd /opt/agent && pnpm install --frozen-lockfile --ignore-scripts --network-concurrency=1 --child-concurrency=1 --config.store-dir=/opt/slicc/.store --reporter=silent > /dev/shm/pnpm.log 2>&1; echo "rc=$?" > /tmp/pnpm.rc) > /dev/null 2>&1 &',
    { cwd: '/' }
  );
  let rc = '';
  while (!rc && Date.now() - t0 < 900_000) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    rc = (
      (await page.evaluate(() => window.opfs.read('tmp/pnpm.rc').catch(() => null))) ?? ''
    ).trim();
  }
  const r = {
    stdout: `${rc}\n${(await bash('tail -c 2000 /dev/shm/pnpm.log', { cwd: '/' })).stdout}`,
  };
  const wall = Date.now() - t0;
  const end = await counters(bash);
  assert.match(r.stdout, /^rc=0\n/, r.stdout);
  const [calls, lookups, requests] = end.map((v, i) => v - (start[i] ?? 0));
  const line = `agent install: ${(wall / 1000).toFixed(1)} s wall, ${calls} kernel calls, ${lookups} OPFS lookups, ${requests} OPFS requests`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  assert.ok(calls <= CALLS_MAX, `${calls} kernel calls, over ${CALLS_MAX}`);
  assert.ok(requests <= REQUESTS_MAX, `${requests} OPFS requests, over ${REQUESTS_MAX}`);
});
