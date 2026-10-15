#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { decide, diffSuites, FINDINGS, resultsMap } from './lib.mjs';

const { values } = parseArgs({
  options: {
    delta: { type: 'string' },
    prev: { type: 'string' },
    release: { type: 'string' },
    base: { type: 'string' },
    out: { type: 'string' },
  },
});

const read = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

const delta = read(values.delta);
const prev = read(values.prev);
const release = read(values.release);
const base = read(values.base);
const missing = [
  ['delta', delta],
  ['the previous release run', prev],
  ['the release suite', release],
  ['the certified suite', base],
].filter(([, v]) => v === undefined);

const nextMap = resultsMap(release?.results ?? []);
const prevMap = resultsMap(prev?.results ?? []);
const rows = (delta?.rows ?? []).map((row) => decide(row, prevMap, nextMap));
const suites = diffSuites(resultsMap(base?.results ?? []), nextMap);
const findings = [
  ...missing.map(([what]) => ({ kind: 'missing-evidence', what })),
  ...rows
    .filter((r) => FINDINGS.has(r.decision))
    .map((r) => ({ kind: r.decision, pr: r.pr, title: r.title })),
  ...suites.regressed.map((t) => ({ kind: 'suite-regression', test: t.test, error: t.error })),
  ...suites.newFailing.map((t) => ({ kind: 'suite-new-failure', test: t.test, error: t.error })),
];
const result = {
  version: delta?.version,
  prev: delta?.prev,
  runs: Object.fromEntries(
    [
      ['prev', prev],
      ['release', release],
      ['base', base],
    ].map(([k, v]) => [
      k,
      v && { exit: v.exit, pass: v.pass, fail: v.fail, skip: v.skip, seconds: v.seconds },
    ])
  ),
  rows,
  suites,
  findings,
};
writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
console.log(`findings: ${findings.length}`);
for (const f of findings)
  console.log(
    `- ${f.kind}${f.pr ? ` #${f.pr}` : ''}${f.test ? ` ${f.test}` : ''}${f.what ? ` ${f.what}` : ''}`
  );
for (const r of rows) console.log(`#${r.pr} ${r.decision}: ${r.title}`);
