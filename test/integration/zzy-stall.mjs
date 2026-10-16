import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { launch as start } from '@ai-ecoverse/slicc-shared-web/harness';
import { booted, installPackage } from './kernel.mjs';

const fixtures = new URL('./fixtures/zzy-stall/', import.meta.url);

function distOf(version) {
  if (!version) return 'dist/';
  const dir = `/tmp/zzy-k-${version}`;
  if (!existsSync(`${dir}/package/dist`)) {
    mkdirSync(dir, { recursive: true });
    const tgz = execFileSync('npm', ['pack', `@ai-ecoverse/slicc-kernel@${version}`, '--silent'], {
      cwd: dir,
    })
      .toString()
      .trim();
    execFileSync('tar', ['-xzf', tgz, '-C', dir]);
  }
  return `${dir}/package/dist/`;
}

export function rounds(tag, version, n) {
  const chrome = start({
    roots: [
      ['/dist/', distOf(version)],
      ['/node_modules/@ai-ecoverse/', 'node_modules/@ai-ecoverse/'],
      ['/fixtures/', 'test/integration/fixtures/'],
      ['/', 'test/integration/page/'],
    ],
    isolated: true,
    timeout: 1500000,
    intercept: ['https://registry.npmjs.org/'],
  });
  after(async () => (await chrome).close());
  for (let round = 0; round < n; round++) {
    test(`${tag} round ${round}`, { timeout: 1500000 }, async (t) => {
      const { page, bash } = await booted(await chrome, t);
      for (const name of ['wasm-bash', 'wasm-coreutils', 'wasi-pnpm'])
        await installPackage(page, name);
      const host = await readFile(new URL('pnpm-host.mjs', fixtures), 'utf8');
      await page.evaluate(
        (s) => window.opfs.write('node_modules/@ai-ecoverse/wasi-pnpm/host/pnpm-host.mjs', s),
        host
      );
      for (const [to, from] of [
        ['package.json', 'agent-package.json'],
        ['pnpm-lock.yaml', 'pnpm-lock.yaml'],
        ['pnpm-workspace.yaml', 'pnpm-workspace.yaml'],
      ]) {
        const text = await readFile(new URL(from, fixtures), 'utf8');
        await page.evaluate((p, s) => window.opfs.write(p, s), `opt/agent/${to}`, text);
      }
      const t0 = Date.now();
      const r = await bash(
        'cd /opt/agent && pnpm install --frozen-lockfile --trust-lockfile --reporter ndjson > /tmp/nd.log 2>&1; echo rc=$?',
        { cwd: '/opt/agent', env: { HOME: '/root', PATH: '/usr/bin:/bin' } }
      );
      const total = Date.now() - t0;
      const nd = (await bash('cat /tmp/nd.log', { cwd: '/' })).stdout;
      const ops = (await bash('cat /tmp/aops-*.log 2>/dev/null', { cwd: '/' })).stdout;
      const L = nd
        .split('\n')
        .filter((l) => l.startsWith('{'))
        .map((l) => JSON.parse(l));
      const first = L[0]?.time ?? 0;
      const gaps = [];
      for (let i = 1; i < L.length; i++) {
        const d = L[i].time - L[i - 1].time;
        if (d > 8000)
          gaps.push(
            `${Math.round(d / 1000)}s@${Math.round((L[i - 1].time - first) / 1000)}(${L[i].name}:${L[i].status ?? L[i].stage ?? ''})`
          );
      }
      const fetched = L.filter((e) => e.name === 'pnpm:progress' && e.status === 'fetched');
      const waits = ops.split('\n').filter((l) => l.startsWith('W '));
      const long = waits.map((l) => l.split(' ')).filter((w) => Number(w[2]) >= 5000);
      const counts = {};
      for (const l of ops.split('\n'))
        if (l.startsWith('S ')) counts[l.split(' ')[3]] = (counts[l.split(' ')[3]] ?? 0) + 1;
      console.log(
        `ZZY ${tag} r${round} ${r.stdout.trim()} total=${Math.round(total / 1000)}s lastFetched=${fetched.length ? Math.round((fetched.at(-1).time - first) / 1000) : '-'}s fetched=${fetched.length} gaps=[${gaps.join(' ')}] submits=${JSON.stringify(counts)} waits>=1s=${waits.length} waits>=5s=[${long.map((w) => `${Math.round(w[2] / 1000)}s@${Math.round(w[1] / 1000)}:${w[4]}`).join(' ')}]`
      );
      for (const w of long.slice(0, 20))
        console.log(`ZZY ${tag} r${round} longwait ${w.join(' ')}`);
    });
  }
}
