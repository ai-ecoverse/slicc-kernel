#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  compatFindingsOf,
  decide,
  diffSuites,
  FINDINGS,
  parseResults,
  resultsMap,
} from './lib.mjs';

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

const readRun = (file) => {
  const run = read(file);
  if (run !== undefined) return run;
  const partial = file.replace(/\.json$/, '.jsonl');
  if (partial === file || !existsSync(partial)) return undefined;
  try {
    return {
      exit: 'no summary',
      partial: true,
      results: parseResults(readFileSync(partial, 'utf8')),
    };
  } catch {
    return undefined;
  }
};

const delta = read(values.delta);
const prev = readRun(values.prev);
const negatives = Object.keys(delta?.baselines ?? {})
  .filter((v) => v !== delta.prev)
  .map((v) => [v, readRun(join(dirname(values.prev), `prev-${v}.json`))]);
const release = readRun(values.release);
const base = readRun(values.base);
const compat = values.compat ? read(values.compat) : undefined;
const missing = [
  ['delta', delta],
  ['the previous release run', prev],
  ...negatives.map(([v, run]) => [`the v${v} run`, run]),
].filter(([, v]) => v === undefined);

const incomplete = [
  ['the previous release run', prev, false],
  ...negatives.map(([v, run]) => [`the v${v} run`, run, false]),
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
  if (typeof exit !== 'number' || exit >= 128) return false;
  if (results.length === 0) return !full && exit === 0 && files.length === 0;
  const failed = results.some((r) => r.status === 'fail' || r.status === 'cancelled');
  return exit === 0 || failed;
}

const releaseComplete =
  release !== undefined &&
  completed(release.exit, release.results ?? [], release.files ?? [], true);

function releaseFinding() {
  if (releaseComplete) return [];
  return [
    {
      kind: 'missing-evidence',
      what: 'the release suite',
      ...(release === undefined
        ? {}
        : { exit: release.exit, results: (release.results ?? []).length }),
      blocking: true,
      remedy: 're-run the failed jobs',
    },
  ];
}

function baseFinding() {
  const results = base?.results ?? [];
  if (base !== undefined && completed(base.exit, results, base.files ?? [], true)) return [];
  const releaseDone =
    releaseComplete &&
    release.exit === 0 &&
    !(release.results ?? []).some((r) => r.status === 'fail' || r.status === 'cancelled');
  const dropped = (delta?.rows ?? []).flatMap((r) => r.dropped ?? []);
  const waived = releaseDone && delta !== undefined && dropped.length === 0;
  return [
    {
      kind: 'missing-evidence',
      what: 'the certified suite',
      ...(base === undefined ? {} : { exit: base.exit, results: results.length }),
      blocking: !waived,
      ...(dropped.length ? { dropped: dropped.length } : {}),
    },
  ];
}

function compatFindings(c) {
  if (!values.compat) return [];
  if (c?.planted) return [];
  return compatFindingsOf(c);
}

const nextMap = resultsMap(release?.results ?? []);
const prevMaps = new Map([
  [delta?.prev, resultsMap(prev?.results ?? [])],
  ...negatives.map(([v, run]) => [v, resultsMap(run?.results ?? [])]),
]);
const rows = (delta?.rows ?? []).map((row) => ({
  ...decide(row, prevMaps.get(row.baseline ?? delta?.prev) ?? new Map(), nextMap),
  ...(row.baseline && row.baseline !== delta?.prev ? { baseline: row.baseline } : {}),
}));
const suites = diffSuites(resultsMap(base?.results ?? []), nextMap, { complete: releaseComplete });
const findings = [
  ...missing.map(([what]) => ({ kind: 'missing-evidence', what })),
  ...releaseFinding(),
  ...incomplete,
  ...baseFinding(),
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
      ...negatives.map(([v, run]) => [`prev-${v}`, run]),
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
