import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { cwd } from 'node:process';
import { CoverageReport } from 'monocart-coverage-reports';
import { artifacts, raw, source } from './artifacts.mjs';

const coverage = {
  name: 'slicc-kernel',
  outputDir: 'coverage',
  reports: ['console-details', 'lcovonly', 'v8'],
  sourceFilter: (path) => path.includes('src/'),
};

async function report() {
  const merged = new CoverageReport(coverage);
  for (const file of await readdir(raw).catch(() => [])) {
    const entries = JSON.parse(await readFile(new URL(file, raw), 'utf8'));
    if (entries.length > 0) await merged.add(entries);
  }
  await merged.generate();
}

async function hotspots() {
  const files = await readdir(artifacts, { recursive: true }).catch(() => []);
  const profiles = files.filter((file) => file.endsWith('.cpuprofile'));
  const self = new Map();
  for (const file of profiles) {
    const { nodes, samples, timeDeltas } = JSON.parse(await readFile(new URL(file, artifacts)));
    const frames = new Map(nodes.map((node) => [node.id, node.callFrame]));
    samples.forEach((id, i) => {
      const { url, functionName, lineNumber, columnNumber } = frames.get(id);
      if (!url.startsWith('http://127.0.0.1:')) return;
      const top = lineNumber === 0 && columnNumber === 0 ? '(top level)' : '(anonymous)';
      const key = `${relative(cwd(), source(url))}:${lineNumber + 1} ${functionName || top}`;
      self.set(key, (self.get(key) ?? 0) + (timeDeltas[i + 1] ?? 0));
    });
  }
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const rows = top.map(([frame, micros]) => `| ${(micros / 1000).toFixed(2)} ms | \`${frame}\` |`);
  const table = [
    `### Hotspots: self time in our scripts across ${profiles.length} CPU profiles`,
    '',
    '| self | frame |',
    '| ---: | :--- |',
    ...rows,
    '',
  ].join('\n');
  await writeFile(new URL('hotspots.md', artifacts), table);
  console.log(table);
}

export async function globalSetup() {
  await rm(artifacts, { recursive: true, force: true });
  await rm(raw, { recursive: true, force: true });
}

export async function globalTeardown() {
  await report();
  await hotspots();
}
