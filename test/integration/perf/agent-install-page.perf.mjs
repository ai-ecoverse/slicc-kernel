import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch } from '../chrome.mjs';
import { booted, installPackage } from '../kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const AGENT = new URL('./agent/', import.meta.url);
const BIOS = '25b32202';
const OFFLINE = Boolean(process.env.SLICC_INSTALL_OFFLINE);
const COUNTERS = ['slicc_fs_calls', 'slicc_opfs_calls', 'slicc_opfs_ops'];

function phases(ndjson, series, wall) {
  const events = ndjson
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  const run = events.find((e) => e.name === 'pnpm:execution-time');
  const fetched = events.filter((e) => e.name === 'pnpm:progress' && e.status === 'fetched');
  const begin = run.endedAt - wall;
  const firstFetch = Math.min(...fetched.map((e) => e.time)) - begin;
  const lastFetch = Math.max(...fetched.map((e) => e.time)) - begin;
  const at = (ms) => series.filter(([t]) => t <= ms).at(-1) ?? series[0];
  const span = (from, to) => {
    const [a, b] = [at(from), to === wall ? series.at(-1) : at(to)];
    return { s: (to - from) / 1000, counts: b.slice(1).map((v, i) => v - a[i + 1]) };
  };
  return {
    start: span(0, firstFetch),
    fetch: span(firstFetch, lastFetch),
    import: span(lastFetch, wall),
    total: span(0, wall),
  };
}

test('a cold install of bios’s agent project into /opt/agent on the OPFS root, timed per pnpm phase with the kernel’s file and OPFS counts', {
  timeout: 1_800_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t, {
    users: 'enforce',
    ...(OFFLINE ? { registry: true } : {}),
  });
  for (const name of ['wasm-coreutils', 'wasm-tls-engine', 'wasi-pnpm'])
    await installPackage(page, name);
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    const text = await readFile(new URL(file, AGENT), 'utf8');
    await page.evaluate((n, x) => window.opfs.write(`opt/agent/${n}`, x), file, text);
  }
  if (OFFLINE) {
    await page.evaluate(
      (x) => window.opfs.write('opt/agent/.npmrc', x),
      'registry=http://registry.test/\n'
    );
  }
  const counters = async () => {
    const reads = COUNTERS.map((c) => `cat /proc/sys/kernel/${c} 2> /dev/null || echo 0`).join(
      '; '
    );
    return (await bash(reads, { cwd: '/' })).stdout.trim().split('\n').map(Number);
  };
  const series = [[0, ...(await counters())]];
  const t0 = Date.now();
  let running = true;
  const sampling = (async () => {
    while (running) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!running) continue;
      const sample = await counters();
      series.push([Date.now() - t0, ...sample]);
      await page.evaluate((v) => {
        window.__install = v;
      }, sample.join(','));
    }
  })();
  const stdout = await page.run(
    { marker: () => window.__install, quietMs: 120_000, maxMs: 1_700_000, label: 'the install' },
    async (script) => (await window.kernel.run(['bash', '-c', script], { cwd: '/' })).stdout,
    'cd /opt/agent && pnpm install --frozen-lockfile --ignore-scripts --config.store-dir=/opt/slicc/.store --reporter=ndjson > /dev/shm/pnpm.ndjson 2>&1; echo "rc=$?"'
  );
  const r = { stdout };
  const wall = Date.now() - t0;
  running = false;
  await sampling;
  series.push([wall, ...(await counters())]);
  const sizes = await bash(
    'du -s --inodes /opt/agent/node_modules /opt/slicc/.store | cut -f1; du -sk /opt/agent/node_modules /opt/slicc/.store | cut -f1',
    { cwd: '/' }
  );
  const [modules, store, modulesKb, storeKb] = sizes.stdout.trim().split('\n').map(Number);
  const log = (await bash('cat /dev/shm/pnpm.ndjson', { cwd: '/' })).stdout;
  assert.equal(r.stdout.trim(), 'rc=0', log.slice(-2000));
  const p = phases(log, series, wall);
  const inodes = modules + store;
  const row = (name, { s, counts }) => `| ${name} | ${s.toFixed(1)} s | ${counts.join(' | ')} |`;
  const per = p.total.counts.map((v) => (v / inodes).toFixed(2));
  const table = [
    `### Agent install baseline (bios ${BIOS}, ${inodes} inodes: ${modules} in node_modules, ${store} in the store; ${modulesKb + storeKb} KB)`,
    '',
    '| phase | wall | kernel fs calls | OPFS lookups | OPFS requests |',
    '|---|---|---|---|---|',
    row('start', p.start),
    row('fetch', p.fetch),
    row('import', p.import),
    row('total', p.total),
    `| per inode | ${(wall / inodes).toFixed(2)} ms | ${per.join(' | ')} |`,
    '',
  ].join('\n');
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
});
