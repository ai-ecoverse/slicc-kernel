import { matchesGlob } from 'node:path';

export function verdict(name, ok, detail = '') {
  const line = `${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` ${String(detail).split('\n')[0]}` : ''}`;
  console.log(line);
  return line;
}

const MERGE = /^Merge pull request #(\d+) from /;
const KIND = /^(\w+)(?:\([^)]*\))?(!)?:/;
const TITLE = /^\s*(?:await\s+)?(?:t\.)?(?:test|it|describe)\(\s*(['"`])((?:\\.|(?!\1).)+)(\1)?/;
const PREFIX = '\u2026';
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@\s*(.*)$/;
const BARE = /^\s*(?:await\s+)?(?:t\.)?(?:test|it|describe)\(\s*$/;
const ARG = /^\s*(['"`])((?:\\.|(?!\1).)+)(\1)?/;
const INTEGRATION = /^test\/integration\/[^/]+\.test\.mjs$/;

export function mergedPrs(commits) {
  const seen = new Set();
  const out = [];
  for (const commit of commits) {
    const message = commit.commit?.message ?? commit.message ?? '';
    const n = MERGE.exec(message)?.[1];
    if (n !== undefined && !seen.has(Number(n))) {
      seen.add(Number(n));
      out.push(Number(n));
    }
  }
  return out.sort((a, b) => a - b);
}

export function kindOf(title) {
  const m = KIND.exec(title ?? '');
  return m ? m[1].toLowerCase() : 'other';
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

export function unquote(text) {
  return text.replace(
    /\\(u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|.)/g,
    (_, all, braced, four, two) => {
      const hex = braced ?? four ?? two;
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      return ESCAPES[all] ?? all;
    }
  );
}

function titleOf(m) {
  const raw = m[1] === '`' ? m[2].replace(/\$\{[^}]*\}?/g, PREFIX) : m[2];
  const title = unquote(raw).replace(/\u2026+/g, PREFIX);
  if (title.replaceAll(PREFIX, '').trim() === '') return undefined;
  return m[3] === undefined && !title.endsWith(PREFIX) ? `${title}${PREFIX}` : title;
}

function enclosing(content, line) {
  const lines = content.split('\n');
  for (let at = Math.min(line, lines.length) - 1; at >= 0; at--) {
    const whole = TITLE.exec(lines[at]);
    if (whole) return titleOf(whole);
    if (BARE.test(lines[at])) {
      const next = ARG.exec(lines[at + 1] ?? '');
      return next ? titleOf(next) : undefined;
    }
  }
  return undefined;
}

const UNREAD = Symbol('unreadable');

function fromHeader(header, content, at) {
  const m = TITLE.exec(header);
  if (m) return titleOf(m) ?? UNREAD;
  if (!BARE.test(header)) return undefined;
  return (content === undefined ? undefined : enclosing(content, at)) ?? UNREAD;
}

function callAt(text, bare) {
  if (bare) {
    const m = ARG.exec(text);
    return { current: (m && titleOf(m)) ?? UNREAD };
  }
  if (BARE.test(text)) return { bare: true };
  const m = TITLE.exec(text);
  return m ? { current: titleOf(m) ?? UNREAD } : {};
}

export function titleScan(patch, content) {
  const titles = new Set();
  const blind = new Set();
  let current;
  let bare = false;
  let waiting = false;
  let at = 0;
  let region = 0;
  const mark = () => {
    if (current === UNREAD) blind.add(region);
    else if (current !== undefined) titles.add(current);
  };
  for (const line of (patch ?? '').split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      at = Number(hunk[1]);
      current = fromHeader(hunk[2], content, at);
      region++;
      bare = false;
      continue;
    }
    const sign = line[0];
    if (sign !== '+' && sign !== '-' && sign !== ' ') continue;
    if (sign !== '-') {
      at++;
      const found = callAt(line.slice(1), bare);
      bare = found.bare === true;
      if ('current' in found) {
        current = found.current;
        region++;
        if (waiting) mark();
        waiting = false;
      }
    }
    if (sign === ' ') continue;
    if (bare) waiting = true;
    else mark();
  }
  if (bare && waiting) blind.add(region);
  return { titles: [...titles], unreadable: blind.size };
}

export function titlesFromPatch(patch, content) {
  return titleScan(patch, content).titles;
}

export function droppedTitles(patch) {
  const added = new Set(
    titlesFromPatch(
      (patch ?? '')
        .split('\n')
        .filter((l) => l.startsWith('+'))
        .join('\n')
    )
  );
  const removed = titlesFromPatch(
    (patch ?? '')
      .split('\n')
      .filter((l) => l.startsWith('-'))
      .map((l) => `+${l.slice(1)}`)
      .join('\n')
  );
  return removed.filter((t) => !added.has(t));
}

export function droppedTests(files) {
  const out = [];
  for (const f of files) {
    const was = f.previous_filename ?? f.filename;
    if (!INTEGRATION.test(was) && !INTEGRATION.test(f.filename)) continue;
    if (f.status === 'removed' || (f.status === 'renamed' && f.previous_filename !== f.filename))
      out.push({ file: was, ...(f.status === 'renamed' ? { to: f.filename } : {}) });
    else for (const title of droppedTitles(f.patch)) out.push({ file: f.filename, title });
  }
  return out;
}

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

export function versionsOnly(before, after) {
  let a;
  let b;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch {
    return false;
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const rest = (o) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(o).filter(([k]) => !DEPENDENCY_SECTIONS.includes(k)))
    );
  if (rest(a) !== rest(b)) return false;
  return DEPENDENCY_SECTIONS.every((section) => {
    const x = Object.keys(a[section] ?? {})
      .sort()
      .join('\n');
    const y = Object.keys(b[section] ?? {})
      .sort()
      .join('\n');
    return x === y;
  });
}

export function rowOf(pr, files, { manifest, contents = {} } = {}) {
  const kind = kindOf(pr.title);
  const tests = files
    .filter((f) => INTEGRATION.test(f.filename) && f.status !== 'removed')
    .map((f) => {
      const { titles, unreadable } = titleScan(f.patch, contents[f.filename]);
      return { file: f.filename, status: f.status, titles, ...(unreadable ? { unreadable } : {}) };
    });
  return {
    pr: pr.number,
    title: pr.title,
    kind,
    breaking: KIND.exec(pr.title ?? '')?.[2] === '!',
    behaviour: behaviourFiles(files).length > 0,
    manifest: manifest === true && names(files).every((f) => MANIFEST_FILES.has(f)),
    src: files.some((f) => f.filename.startsWith('src/')),
    tests,
    dropped: droppedTests(files),
    ...(pr.merge_commit_sha ? { merged: pr.merge_commit_sha } : {}),
  };
}

export function withBaselines(rows, { commits, tags, prev }) {
  const at = new Map(commits.map((c, i) => [c.sha, i]));
  const released = tags
    .filter((t) => at.has(t.sha))
    .map((t) => ({ version: t.version, index: at.get(t.sha) }))
    .sort((a, b) => compareVersions(a.version, b.version));
  return rows.map((row) => {
    const index = row.merged === undefined ? undefined : at.get(row.merged);
    if (index === undefined) return { ...row, baseline: prev };
    const holding = released.findIndex((t) => t.index >= index);
    const before = holding === -1 ? released.at(-1) : released[holding - 1];
    const baseline = before?.version ?? prev;
    return { ...row, baseline };
  });
}

export function baselineFiles(rows, prev) {
  const out = {};
  for (const r of rows.filter((x) => x.behaviour && x.tests.length > 0)) {
    const files = (out[r.baseline ?? prev] ??= new Set());
    for (const t of r.tests) files.add(t.file);
  }
  return Object.fromEntries(
    Object.entries(out)
      .sort(([a], [b]) => compareVersions(a, b))
      .map(([v, files]) => [v, [...files].sort()])
  );
}

export function deltaFiles(rows) {
  return [
    ...new Set(rows.filter((r) => r.behaviour).flatMap((r) => r.tests.map((t) => t.file))),
  ].sort();
}

const key = (r) => `${r.file} :: ${r.name}`;

export function resultsMap(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = key(r);
    const before = map.get(k);
    if (!before || r.status === 'fail') map.set(k, r);
  }
  return map;
}

const patterns = new Map();

function patternOf(title) {
  let re = patterns.get(title);
  if (!re) {
    const parts = title.split(PREFIX).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    re = new RegExp(`^${parts.join('[\\s\\S]*')}$`);
    patterns.set(title, re);
  }
  return re;
}

function matches(segment, title) {
  return title.includes(PREFIX) ? patternOf(title).test(segment) : segment === title;
}

function under(results, file, title) {
  return [...results.values()].filter((r) => {
    if (r.file !== file) return false;
    const segments = r.name.split(' > ');
    return segments.some((segment) => matches(segment, title));
  });
}

function verdictOf(rows) {
  if (rows.length === 0) return 'missing';
  if (rows.some((r) => r.status === 'fail' || r.status === 'cancelled')) return 'fail';
  if (rows.every((r) => r.status === 'skip' || r.status === 'todo')) return 'skip';
  return 'pass';
}

export function decide(row, prev, next) {
  const checks = row.tests.flatMap((t) =>
    t.titles.map((title) => ({
      file: t.file,
      title,
      next: verdictOf(under(next, t.file, title)),
      prev: verdictOf(under(prev, t.file, title)),
    }))
  );
  const base = { pr: row.pr, title: row.title, kind: row.kind, checks };
  if (!row.behaviour) return { ...base, decision: 'not-behaviour' };
  if (row.manifest) return { ...base, decision: 'manifest' };
  if (row.tests.length === 0) return { ...base, decision: 'no-test' };
  if (checks.length === 0 || row.tests.some((t) => t.unreadable > 0))
    return { ...base, decision: 'no-titles' };
  if (checks.some((c) => c.next === 'fail')) return { ...base, decision: 'fails-on-release' };
  const ran = checks.filter((c) => c.next === 'pass');
  if (ran.length === 0) return { ...base, decision: 'not-run' };
  if (ran.some((c) => c.prev === 'fail')) return { ...base, decision: 'negative' };
  if (ran.some((c) => c.prev === 'missing')) return { ...base, decision: 'prev-not-run' };
  if (row.kind !== 'fix') return { ...base, decision: 'passes' };
  return { ...base, decision: 'no-negative' };
}

export const FINDINGS = new Set([
  'no-test',
  'no-titles',
  'fails-on-release',
  'not-run',
  'prev-not-run',
  'no-negative',
]);

export function diffSuites(base, next, { complete = true } = {}) {
  const out = {
    regressed: [],
    newFailing: [],
    fixed: [],
    stillFailing: [],
    removed: [],
    unrun: [],
    added: 0,
    same: 0,
  };
  for (const [k, r] of next) {
    const b = base.get(k);
    const failing = r.status === 'fail' || r.status === 'cancelled';
    if (!b) {
      out.added++;
      if (failing) out.newFailing.push({ test: k, error: r.error ?? '' });
      continue;
    }
    const wasFailing = b.status === 'fail' || b.status === 'cancelled';
    if (failing && !wasFailing)
      out.regressed.push({ test: k, was: b.status, error: r.error ?? '' });
    else if (failing) out.stillFailing.push({ test: k, error: r.error ?? '' });
    else if (wasFailing) out.fixed.push({ test: k });
    else out.same++;
  }
  for (const k of base.keys())
    if (!next.has(k)) (complete ? out.removed : out.unrun).push({ test: k });
  return out;
}

export function parseResults(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
}

export function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

const GLOB = /(['"])test\/integration\/\*\.test\.mjs\1/;

export function testCommand(script, reporter, destination, files) {
  if (!/\bnode --test\b/.test(script))
    throw new Error(`the test script runs no node --test: ${script}`);
  const flags = `node --test --test-reporter=${reporter} --test-reporter-destination=${destination} --test-reporter=spec --test-reporter-destination=stdout`;
  const withFlags = script.replace(/\bnode --test\b/, flags);
  if (files.length === 0) return withFlags;
  const listed = files.map((f) => `'${f}'`).join(' ');
  return GLOB.test(withFlags) ? withFlags.replace(GLOB, listed) : `${withFlags} ${listed}`;
}

const SLSA_SUBJECT = (version) => `pkg:npm/%40ai-ecoverse/slicc-kernel@${version}`;

export function provenanceProblems(statement, { repo, version, sha512, gitHead }) {
  const problems = [];
  const subject = statement.subject?.find((s) => s.name === SLSA_SUBJECT(version));
  if (subject?.digest?.sha512 !== sha512)
    problems.push("the provenance subject isn't this tarball's sha512");
  const build = statement.predicate?.buildDefinition ?? {};
  const workflow = build.externalParameters?.workflow ?? {};
  const gitCommit = build.resolvedDependencies?.[0]?.digest?.gitCommit;
  const builder = statement.predicate?.runDetails?.builder?.id ?? '';
  const facts = { workflow, gitCommit, builder };
  if (workflow.repository !== `https://github.com/${repo}`) {
    problems.push(`provenance repository is ${workflow.repository}`);
  }
  if (workflow.path !== '.github/workflows/release.yml')
    problems.push(`provenance workflow is ${workflow.path}`);
  if (workflow.ref !== 'refs/heads/main') problems.push(`provenance ref is ${workflow.ref}`);
  if (!builder.endsWith('/github-hosted'))
    problems.push(`provenance builder is ${builder || 'missing'}`);
  if (!/^[0-9a-f]{40}$/.test(gitCommit ?? '')) {
    problems.push(`provenance gitCommit is ${gitCommit}`);
    facts.gitCommit = undefined;
  } else if (gitCommit !== gitHead) {
    problems.push(`provenance gitCommit ${gitCommit} isn't the package's gitHead ${gitHead}`);
  }
  return { problems, facts };
}

export function knownLine(repo, entries) {
  const out = [];
  for (const entry of entries) {
    const text = String(entry).trim();
    const local = /^#(\d+)$/.exec(text);
    const full = local ? `${repo}#${local[1]}` : text;
    if (full && !out.includes(full)) out.push(full);
  }
  return out;
}

const CRASH =
  /renderer crashed|page crashed|Segmentation fault|SIGSEGV|SIGABRT|core dumped|exit code 139/i;

export function crashed(text) {
  return CRASH.test(text ?? '');
}

export function rerunSet(regressions) {
  return [...new Set(regressions.map((r) => `${r.recipe}@${r.version}`))].join(',');
}

export function compatRegressions(report, rerun, referenceText = () => '') {
  const regressions = (report?.results ?? []).filter((r) => r.verdict === 'regression');
  return regressions.map((r) => {
    const again = rerun?.results?.find(
      (x) => x.recipe === r.recipe && x.spec === r.spec && x.users === r.users
    );
    const row = {
      package: r.package,
      recipe: r.recipe,
      version: r.version,
      spec: r.spec,
      users: r.users,
      error: String(r.error ?? '').slice(0, 600),
      crash: crashed(r.error),
    };
    if (!rerun) return { ...row, rerun: 'none', reproduced: true };
    if (!again) return { ...row, rerun: 'missing', reproduced: true };
    if (again.version !== r.version) {
      return { ...row, rerun: 'rerun-mismatch', rerunVersion: again.version, reproduced: true };
    }
    const reproduced = again.verdict === 'regression';
    const referenceCrash = crashed(again.reference?.error) || crashed(referenceText(again));
    return {
      ...row,
      rerun: again.verdict,
      reproduced,
      crashAgain: reproduced && crashed(again.error),
      referenceCrash,
    };
  });
}

export function compatFindingsOf(compat) {
  if (!compat?.found) return [{ kind: 'missing-evidence', what: 'kernel-compat' }];
  const rows = compat.regressions ?? [];
  const out = rows.map((r) => ({
    kind: r.reproduced
      ? r.crashAgain && !r.referenceCrash
        ? 'compat-crash'
        : 'compat-regression'
      : 'compat-flake',
    package: `${r.recipe}@${r.version}`,
    spec: r.spec,
    rerun: r.rerun,
    error: r.error,
  }));
  if (rows.length === 0 && compat.conclusion !== 'success') {
    out.push({
      kind: 'compat-incomplete',
      what: 'kernel-compat',
      shards: compat.missingShards ?? [],
      ...(compat.shardRerun ? { rerun: compat.shardRerun.conclusion } : {}),
      error: `kernel-compat ${compat.conclusion} with no regression${(compat.missingShards ?? []).length ? `, no report from shard ${compat.missingShards.join(', ')}` : ''}`,
    });
  }
  return out;
}

export function missingShards(jobs, artifacts) {
  const reported = new Set(
    artifacts.map((n) => /-shard-(\d+)$/.exec(n)?.[1]).filter((n) => n !== undefined)
  );
  return jobs
    .map((j) => /shard \((\d+)\)$/.exec(j.name)?.[1])
    .filter((n) => n !== undefined && !reported.has(n))
    .map(Number)
    .sort((a, b) => a - b);
}

export function knownAsOf(issue, { fixedBefore, releasedAt, version, fixedIn }) {
  if (fixedIn) return compareVersions(version, fixedIn) < 0;
  if (issue.state === 'OPEN' || issue.state === 'open') return true;
  if (issue.stateReason === 'NOT_PLANNED' || issue.stateReason === 'DUPLICATE') return false;
  const fixes = (issue.closedBy ?? []).filter((pr) => pr.merged && pr.mergeCommit);
  if (fixes.length > 0) return !fixes.some((pr) => fixedBefore(pr.mergeCommit));
  return Boolean(releasedAt && issue.closedAt && releasedAt < issue.closedAt);
}

const GAPS = new Set(['no-test', 'no-negative', 'not-run']);

export function negativeEvidence(findings, incomplete) {
  const unrun = (findings ?? [])
    .filter((f) => (f.kind === 'prev-not-run' || f.kind === 'no-titles') && f.pr)
    .map((f) =>
      f.kind === 'no-titles'
        ? `#${f.pr} changes shipped paths, and the delta can't read the titles of the tests it changes, so their NEGATIVE can't be judged`
        : `#${f.pr} changes shipped paths, and its tests' NEGATIVE on the previous tree has no result`
    );
  return withMissing(incomplete, unrun);
}

export function unfinishedFiles(expected, rows) {
  const seen = new Map();
  for (const r of rows) {
    const cut = r.status === 'cancelled' || (r.status === 'fail' && r.name === r.file);
    seen.set(r.file, (seen.get(r.file) ?? false) || cut);
  }
  const files = new Set([...expected, ...seen.keys()]);
  return [...files].filter((f) => f && (!seen.has(f) || seen.get(f))).sort();
}

export function mergeRetry(rows, retried, files) {
  const again = new Set(files);
  return [...rows.filter((r) => !again.has(r.file)), ...retried];
}

export function releaseEvidence(findings) {
  const f = (findings ?? []).find(
    (x) => x.kind === 'missing-evidence' && x.what === 'the release suite' && x.blocking
  );
  if (!f) return undefined;
  const files = f.files ?? [];
  const named = files.length
    ? `${files.length} files without results: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ', \u2026' : ''}`
    : f.results === undefined
      ? 'no results'
      : `${f.results} results, exit ${f.exit}`;
  return { files, named, remedy: f.remedy ?? 're-run the failed jobs' };
}

export function verdictLine({
  name,
  version,
  planted,
  ci,
  problems,
  review,
  incomplete,
  certified,
  known = [],
}) {
  const tag = `${name}@${version}${planted ? ` (planted ${planted})` : ''}`;
  if (problems.length === 0 && !incomplete && review?.verdict === 'certified') {
    return { state: 'success', line: certified };
  }
  if (incomplete && problems.length === 0) {
    return {
      state: 'error',
      line: `cert-ci: INCOMPLETE ${tag} (${incomplete.named}; ${incomplete.remedy}) (${ci}; known: ${known.length ? known.join(', ') : 'none'})`,
    };
  }
  const why = [
    ...(review?.verdict === 'fail' && !incomplete
      ? [`the reviewer: ${review.reason || 'no reason given'}`]
      : []),
    ...(review?.verdict === 'certified' && !incomplete ? ['the reviewer certified it'] : []),
    ...problems,
    ...(incomplete ? [`the release suite is incomplete (${incomplete.named})`] : []),
  ];
  return { state: 'failure', line: `cert-ci: FAIL ${tag}: ${why.join('; ')} (${ci})` };
}

export function baseEvidence(findings) {
  const f = (findings ?? []).find(
    (x) => x.kind === 'missing-evidence' && x.what === 'the certified suite'
  );
  if (!f) return { note: '' };
  const note = `base suite incomplete (${f.results ?? 0} results)`;
  if (!f.blocking) return { note };
  const why = f.dropped
    ? `the delta drops ${f.dropped} test files or titles`
    : "the release suite isn't complete and all-pass";
  return {
    note,
    problem: `the certified suite didn't finish (${f.results ?? 0} results), and ${why}, so nothing stands in for it`,
  };
}

export function gapsOf(findings) {
  return (findings ?? []).filter((f) => GAPS.has(f.kind) && f.pr).map((f) => `#${f.pr} ${f.kind}`);
}

export async function pickRelease(tags, version, stateOf, { pending = false } = {}) {
  const earlier = tags
    .filter((t) => compareVersions(t, version) < 0)
    .sort(compareVersions)
    .reverse();
  for (const tag of earlier) {
    const state = await stateOf(tag);
    if (state === 'success' || (pending && state === 'pending')) return tag;
  }
  return undefined;
}

export function covering(tags, prev, version) {
  return tags
    .filter((t) => compareVersions(t, prev) > 0 && compareVersions(t, version) <= 0)
    .sort(compareVersions);
}

const BEHAVIOUR_PATHS = [
  /^src\//,
  /^build\.mjs$/,
  /^package(-lock)?\.json$/,
  /^tsconfig[^/]*\.json$/,
  /^\.releaserc/,
  /^tools\/release-recover\.mjs$/,
  /^\.github\/workflows\/(release|ci)\.yml$/,
];

export const REVIEWER_GLOBS = [
  '.github/workflows/cert*.yml',
  '.github/workflows/cert*.yaml',
  'scripts/cert/**',
  'scripts/cert/.*',
  'scripts/cert/.*/**',
  'scripts/cert/**/.*',
  'scripts/cert/**/.*/**',
  'tools/cert-review/**',
  'tools/cert-review/.*',
  'tools/cert-review/.*/**',
  'tools/cert-review/**/.*',
  'tools/cert-review/**/.*/**',
  '.github/actions/cert-self-guard/**',
  '.github/actions/cert-self-guard/.*',
  '.github/actions/cert-self-guard/.*/**',
  '.github/actions/cert-self-guard/**/.*',
  '.github/actions/cert-self-guard/**/.*/**',
  '.github/runner.mjs',
];

export const REVIEWER_DIRS = [
  'scripts/cert/',
  'tools/cert-review/',
  '.github/actions/cert-self-guard/',
];

const isReviewer = (name) =>
  REVIEWER_DIRS.some((dir) => name.startsWith(dir)) ||
  REVIEWER_GLOBS.some((glob) => matchesGlob(name, glob));
const names = (files) =>
  (files ?? []).flatMap((f) => [
    f.filename ?? f,
    ...(f.previous_filename ? [f.previous_filename] : []),
  ]);

export function behaviourFiles(files) {
  return names(files).filter(
    (name) => isReviewer(name) || BEHAVIOUR_PATHS.some((re) => re.test(name))
  );
}

export function reviewsItself(files) {
  return names(files).some(isReviewer);
}

export function withMissing(incomplete, reasons) {
  const more = (reasons ?? []).filter(Boolean);
  if (more.length === 0) return incomplete;
  const named = [incomplete?.named, ...more].filter(Boolean).join('; ');
  return { files: incomplete?.files ?? [], named, remedy: 're-run the failed jobs' };
}

export function jobsEvidence(text, incomplete) {
  const failed = String(text ?? '')
    .split(',')
    .map((x) => x.trim().split('='))
    .filter(([job, result]) => job && result !== 'success')
    .map(([job, result]) => `the ${job} job ended ${result || 'without a result'}`);
  return withMissing(incomplete, failed);
}

export function statusAt(statuses, contexts, at) {
  const cutoff = Date.parse(at ?? '');
  const time = (s) => Date.parse(s.created_at ?? '');
  for (const context of contexts) {
    const seen = statuses
      .filter((s) => s.context === context && !(time(s) > cutoff))
      .sort((a, b) => time(b) - time(a));
    const found = seen.find((s) => s.state !== 'pending') ?? seen[0];
    if (found) return found;
  }
  return undefined;
}

export function groupVerdict(prs) {
  const lines = [];
  const missing = [];
  for (const p of prs) {
    if (p.behaviour.length === 0) {
      lines.push(`#${p.pr} not behaviour`);
      continue;
    }
    if (p.state === 'success') {
      lines.push(`#${p.pr} certified at ${p.head.slice(0, 12)}`);
      continue;
    }
    missing.push(
      `#${p.pr} has ${p.state ? `a ${p.state} cert-review` : 'no cert-review'} on its head ${p.head.slice(0, 12)}${p.description ? ` (${p.description})` : ''}`
    );
  }
  return missing.length
    ? {
        state: 'failure',
        line: `not certified: ${missing.join('; ')}`,
        lines: [...lines, ...missing],
      }
    : { state: 'success', line: lines.join(', ') || 'no pull requests', lines };
}

export const NAME = '@ai-ecoverse/slicc-kernel';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const semver = (v) => SEMVER.exec(v)?.slice(1).map(Number);
export const older = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

export function covers(version, tags, published) {
  const released = (tags ?? []).map((t) => t.replace(/^v/, '')).filter((v) => semver(v));
  const before = (published ?? []).filter((v) => semver(v) && older(v, version));
  const since = before.reduce((a, v) => (a && !older(a, v) ? a : v), undefined);
  const first = released
    .filter((v) => older(v, version) && (!since || older(since, v)))
    .reduce((a, v) => (a && older(a, v) ? a : v), undefined);
  return first ? `${first}–${version}` : version;
}

export function releaseNotes(body, line, { version, sha256 }) {
  const text = body ?? '';
  const prefix = `certified ${NAME}@${version} sha256=`;
  const found = [
    ...text.matchAll(
      new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}([0-9a-f]{64})`, 'g')
    ),
  ].map((m) => m[1]);
  if (found.some((sha) => sha !== sha256))
    return {
      conflict: `the release notes already certify sha256=${found.find((sha) => sha !== sha256)}`,
    };
  if (found.length) return { unchanged: true, body: text };
  const kept = text
    .replace(/\n*<!-- cert-verify -->[\s\S]*?<!-- \/cert-verify -->\n*/g, '')
    .trimEnd();
  return {
    body: `${kept}${kept ? '\n\n' : ''}<!-- cert-verify -->\n${line}\n<!-- /cert-verify -->\n`,
  };
}

const MANIFEST_FILES = new Set(['package.json', 'package-lock.json']);

export function manifestOnly(files) {
  const behaviour = behaviourFiles(files);
  return (
    behaviour.length > 0 && !reviewsItself(files) && behaviour.every((f) => MANIFEST_FILES.has(f))
  );
}

const SHIPPED_MANIFEST_IGNORES = ['devDependencies', 'version', 'gitHead'];

const placeholder = (buffer, version) => {
  const token = Buffer.from(version);
  const parts = [];
  let at = 0;
  for (let i = buffer.indexOf(token); i !== -1; i = buffer.indexOf(token, at)) {
    parts.push(buffer.subarray(at, i), Buffer.from('\0SLICC_VERSION\0'));
    at = i + token.length;
  }
  parts.push(buffer.subarray(at));
  return Buffer.concat(parts);
};

const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(',')}}`
      : JSON.stringify(value);

const manifestOf = (buffer) => {
  const m = JSON.parse(buffer.toString('utf8'));
  for (const key of SHIPPED_MANIFEST_IGNORES) delete m[key];
  return canonical(m);
};

const parsedSame = (a, b, read) => {
  try {
    return read(a) === read(b);
  } catch {
    return false;
  }
};

function fileDifference(name, a, b, candidate, base) {
  if (!a || !b) return `${name} only in the ${a ? 'candidate' : 'base'}`;
  if (a.type !== b.type)
    return `${name} is a ${a.type} in the candidate and a ${b.type} in the base`;
  if (a.mode !== b.mode) return `${name} mode ${a.mode.toString(8)} vs ${b.mode.toString(8)}`;
  if (name === 'package.json')
    return parsedSame(a.bytes, b.bytes, manifestOf)
      ? undefined
      : 'package.json differs beyond devDependencies, version and gitHead';
  const x = placeholder(a.bytes, candidate.version);
  const y = placeholder(b.bytes, base.version);
  if (name.endsWith('.map'))
    return parsedSame(x, y, (bytes) => {
      const map = JSON.parse(bytes.toString('utf8'));
      delete map.mappings;
      return canonical(map);
    })
      ? undefined
      : `${name} differs beyond its mappings`;
  return x.equals(y) ? undefined : `${name} differs`;
}

export function sameDist(candidate, base) {
  if (
    !candidate.version ||
    !base.version ||
    candidate.version.includes(base.version) ||
    base.version.includes(candidate.version)
  )
    return {
      identical: false,
      differences: ['the two versions are empty or contain each other: not compared'],
    };
  const names = [...new Set([...candidate.files.keys(), ...base.files.keys()])].sort();
  const differences = names
    .map((name) =>
      fileDifference(name, candidate.files.get(name), base.files.get(name), candidate, base)
    )
    .filter(Boolean);
  return { identical: differences.length === 0, differences };
}

const hexOf = (digest) =>
  String(digest ?? '')
    .replace(/^sha256:/, '')
    .toLowerCase();

function readExpectations(expect, problems) {
  const wanted = new Map();
  const named = new Set();
  for (const spec of expect) {
    const m = /^([^=]+)=(\*|\d*)(?:@((?:sha256:)?[0-9a-fA-F]*))?$/.exec(spec);
    if (!m) problems.push(`unreadable expectation ${spec}`);
    else if (m[2] === '*') named.add(m[1]);
    else wanted.set(m[1], { id: m[2] ? Number(m[2]) : undefined, digest: m[3] ? hexOf(m[3]) : '' });
  }
  return { wanted, named };
}

function producedProblem(live, name, want) {
  const found = live.find((a) => a.id === want.id);
  if (!found) return `${name}: its producer's artifact ${want.id} is gone`;
  if (found.name !== name) return `${name}: artifact ${want.id} is named ${found.name}`;
  if (want.digest && hexOf(found.digest) !== want.digest)
    return `${name}: artifact ${want.id} has digest ${hexOf(found.digest) || 'none'}, its producer uploaded ${want.digest}`;
  return undefined;
}

export function artifactProblems(artifacts, expect, prefixes) {
  const live = artifacts.filter((a) => !a.expired);
  const problems = [];
  const { wanted, named } = readExpectations(expect, problems);
  for (const name of named) {
    const count = live.filter((a) => a.name === name).length;
    if (count > 1) problems.push(`${name}: ${count} artifacts by that name`);
  }
  for (const [name, want] of wanted) {
    const problem = want.id === undefined ? undefined : producedProblem(live, name, want);
    if (problem) problems.push(problem);
  }
  const ids = new Set([...wanted.values()].map((w) => w.id).filter((id) => id !== undefined));
  for (const a of live) {
    if (!prefixes.some((p) => a.name.startsWith(p)) || ids.has(a.id) || named.has(a.name)) continue;
    problems.push(`${a.name} (${a.id}) was uploaded by no producer job`);
  }
  return problems;
}

const named = (rows) =>
  rows
    .slice(0, 3)
    .map((r) => `${r.shard}: ${r.test}`)
    .join('; ') + (rows.length > 3 ? ` and ${rows.length - 3} more` : '');

function unusable(result, biosRef) {
  if (!result || typeof result !== 'object' || !result.counts)
    return ['the canary left no readable result'];
  const out = [];
  if (biosRef && result.biosRef !== biosRef)
    out.push(
      `the result is from bios ${String(result.biosRef || 'unknown').slice(0, 12)}, not the pinned ${biosRef.slice(0, 12)}`
    );
  for (const s of result.missingShards ?? []) out.push(`shard ${s} missing`);
  for (const e of result.unexplainedExits ?? [])
    out.push(`shard ${e.shard} exited ${e.exit} without a failing test`);
  for (const r of result.refused ?? []) out.push(`refused ${r.name}`);
  if ((result.ambiguous ?? []).length) out.push('ambiguous test keys');
  const ran = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
  if (!ran) out.push('0 tests ran');
  return out;
}

function failing(result, counts) {
  const rows = [...(result.regressions ?? []), ...(result.failures ?? [])];
  const n = (counts.regression ?? 0) + (counts.fail ?? 0);
  if (n === 0 && rows.length === 0) return undefined;
  const detail = rows.length ? named(rows) : 'their rows are missing from the result';
  return `${counts.regression ?? 0} regressions, ${counts.fail ?? 0} failures (${detail})`;
}

const SHARD_NAMES_MAX = 32;

export function downstreamOf(result, { biosRef = '', shards = [] } = {}) {
  const listed = shards.join(',');
  const shown = listed.length > SHARD_NAMES_MAX ? `${shards.length} shards` : listed;
  const where = `bios ${String(result?.biosRef || biosRef).slice(0, 12)} ${shown}`.trim();
  const run = result?.url ? ` (${result.url})` : '';
  const gaps = unusable(result, biosRef);
  if (gaps.length)
    return {
      state: 'INCOMPLETE',
      line: `downstream: INCOMPLETE ${where}: ${gaps.slice(0, 3).join(', ')}${run}`,
      notify: [],
    };
  const counts = result.counts;
  const both = result.both ?? [];
  const flaky = result.flaky?.length ? `; flaky ${result.flaky.length}` : '';
  const known = both.length ? `; known downstream failures ${both.length} (${named(both)})` : '';
  const notify = both.length ? [`bios canary fails on main's pins too: ${named(both)}${run}`] : [];
  const why = failing(result, counts);
  if (why)
    return { state: 'FAIL', line: `downstream: FAIL ${where}: ${why}${known}${run}`, notify };
  const passed = counts.pass > 0;
  if (both.length && !passed)
    return {
      state: 'NOT_JUDGED',
      line: `downstream: not judged (bios canary failing on main) ${where}: ${both.length} tests fail on the candidate and on main alike${run}`,
      notify: [
        `bios canary is failing on main: every failing test fails on main's pins too (${named(both)})${run}`,
      ],
    };
  if (!passed)
    return {
      state: 'INCOMPLETE',
      line: `downstream: INCOMPLETE ${where}: no downstream test passed${flaky}${run}`,
      notify,
    };
  return {
    state: 'PASS',
    line: `downstream: PASS ${where}: ${counts.pass} pass${known}${flaky}${run}`,
    notify,
  };
}

export const DOWNSTREAM_OK = new Set(['PASS', 'NOT_JUDGED']);

export function downstreamLine(lines) {
  if (lines.length === 0) return 'downstream: not run (no merge group of this release carried it)';
  const unique = [...new Set(lines)];
  return unique.length === 1
    ? unique[0]
    : `downstream: ${unique.map((l) => l.replace(/^downstream: /, '')).join(' | ')}`;
}

async function quietly(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function attestationsAt(get, at) {
  let res;
  try {
    res = await get(at);
  } catch (error) {
    return { missing: `attestations unreachable (${error?.message ?? 'network error'})` };
  }
  if (res.ok) {
    try {
      return { res, body: await res.json() };
    } catch (error) {
      return { missing: `attestations unreadable (${error?.message ?? 'body error'})` };
    }
  }
  if (res.status !== 404) return { problem: `attestations answered ${res.status}` };
  return { missing: 'attestations answered 404' };
}

export async function awaitAttestations({
  url,
  fetch: get,
  modified,
  servedAt,
  now = Date.now,
  sleep,
  deadline = Number.POSITIVE_INFINITY,
  graceMs = 30 * 60_000,
  quietMs = 10 * 60_000,
  everyMs = 15_000,
}) {
  let last;
  let quietSince = now();
  let missing = 'no attestations on npm';
  for (;;) {
    const at = await quietly(() => (typeof url === 'function' ? url() : url), undefined);
    if (at) {
      const found = await attestationsAt(get, at);
      if (!found.missing) return found;
      missing = found.missing;
    }
    const changed = await quietly(modified, last);
    if (changed !== last) {
      last = changed;
      quietSince = now();
    }
    const served = now() - servedAt;
    const minutes = (ms) => Math.round(ms / 60_000);
    if (now() >= deadline)
      return {
        problem: `${missing} for ${minutes(served)} min after npm started serving it, through the whole wait`,
      };
    if (served >= graceMs && now() - quietSince >= quietMs)
      return {
        problem: `${missing} for ${minutes(served)} min after npm started serving it, and its packument stopped changing ${minutes(now() - quietSince)} min ago`,
      };
    await sleep(everyMs);
  }
}

export async function downloadTarball({
  url,
  fetch: get,
  now = Date.now,
  sleep,
  deadline = Number.POSITIVE_INFINITY,
  everyMs = 15_000,
  log = () => {},
}) {
  for (;;) {
    let failure;
    try {
      const res = await get(url);
      if (!res.ok) return { problem: `downloading ${url} answered ${res.status}` };
      return { bytes: Buffer.from(await res.arrayBuffer()) };
    } catch (error) {
      failure = String(error?.message ?? error);
    }
    if (now() >= deadline)
      return { problem: `downloading ${url} failed through the whole wait: ${failure}` };
    log(`downloading ${url} failed, retrying: ${failure}`);
    await sleep(everyMs);
  }
}
