#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { compatFindingsOf, decide, diffSuites, FINDINGS, resultsMap } from './lib.mjs';

const { values } = parseArgs({
  options: {
    delta: { type: 'string' },
    prev: { type: 'string' },
    release: { type: 'string' },
    base: { type: 'string' },
    compat: { type: 'string', default: '' },
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
const compat = values.compat ? read(values.compat) : undefined;
const missing = [
  ['delta', delta],
  ['the previous release run', prev],
  ['the release suite', release],
  ['the certified suite', base],
].filter(([, v]) => v === undefined);

const incomplete = [
  ['the release suite', release, true],
  ['the certified suite', base, true],
  ['the previous release run', prev, false],
]
  .filter(
    ([, v, full]) => v !== undefined && !completed(v.exit, v.results ?? [], v.files ?? [], full)
  )
  .map(([what, v]) => ({
    kind: 'suite-incomplete',
    what,
    exit: v.exit,
    results: (v.results ?? []).length,
  }));

function completed(exit, results, files, full) {
  if (typeof exit !== 'number') return false;
  if (results.length === 0) return !full && exit === 0 && files.length === 0;
  const failed = results.some((r) => r.status === 'fail' || r.status === 'cancelled');
  return exit === 0 || failed;
}

function compatFindings(c) {
  if (!values.compat) return [];
  if (c?.planted) return [];
  return compatFindingsOf(c);
}

const nextMap = resultsMap(release?.results ?? []);
const prevMap = resultsMap(prev?.results ?? []);
const rows = (delta?.rows ?? []).map((row) => decide(row, prevMap, nextMap));
const suites = diffSuites(resultsMap(base?.results ?? []), nextMap);
const findings = [
  ...missing.map(([what]) => ({ kind: 'missing-evidence', what })),
  ...incomplete,
  ...rows
    .filter((r) => FINDINGS.has(r.decision))
    .map((r) => ({ kind: r.decision, pr: r.pr, title: r.title })),
  ...suites.regressed.map((t) => ({ kind: 'suite-regression', test: t.test, error: t.error })),
  ...suites.newFailing.map((t) => ({ kind: 'suite-new-failure', test: t.test, error: t.error })),
  ...compatFindings(compat),
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
  compat: compat && {
    run: compat.run,
    conclusion: compat.conclusion,
    verdict: compat.verdict,
    summary: compat.summary,
    rerun: compat.rerun,
    regressions: compat.regressions,
  },
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
