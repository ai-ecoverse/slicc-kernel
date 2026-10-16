const MERGE = /^Merge pull request #(\d+) from /;
const KIND = /^(\w+)(?:\([^)]*\))?(!)?:/;
const BEHAVIOUR = new Set(['fix', 'feat', 'perf', 'revert']);
const TITLE = /^\s*(?:await\s+)?(?:t\.)?(?:test|it|describe)\(\s*(['"`])((?:\\.|(?!\1).)+)(\1)?/;
const PREFIX = '\u2026';
const HUNK = /^@@[^@]*@@\s*(.*)$/;
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

export function titlesFromPatch(patch) {
  const titles = new Set();
  for (const line of (patch ?? '').split('\n')) {
    const hunk = HUNK.exec(line);
    const text = hunk ? hunk[1] : line.startsWith('+') ? line.slice(1) : undefined;
    if (text === undefined) continue;
    const m = TITLE.exec(text);
    if (!m) continue;
    const title = unquote(m[2]);
    const cut = m[1] === '`' ? title.indexOf('${') : -1;
    if (cut === 0) continue;
    if (cut > 0) titles.add(`${title.slice(0, cut)}${PREFIX}`);
    else if (m[3] === undefined) titles.add(`${title}${PREFIX}`);
    else titles.add(title);
  }
  return [...titles];
}

export function rowOf(pr, files) {
  const kind = kindOf(pr.title);
  const tests = files
    .filter((f) => INTEGRATION.test(f.filename) && f.status !== 'removed')
    .map((f) => ({ file: f.filename, status: f.status, titles: titlesFromPatch(f.patch) }));
  return {
    pr: pr.number,
    title: pr.title,
    kind,
    breaking: KIND.exec(pr.title ?? '')?.[2] === '!',
    behaviour: BEHAVIOUR.has(kind),
    src: files.some((f) => f.filename.startsWith('src/')),
    tests,
  };
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

function matches(segment, title) {
  return title.endsWith(PREFIX) ? segment.startsWith(title.slice(0, -1)) : segment === title;
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
  if (row.tests.length === 0) return { ...base, decision: 'no-test' };
  if (checks.length === 0) return { ...base, decision: 'no-titles' };
  if (checks.some((c) => c.next === 'fail')) return { ...base, decision: 'fails-on-release' };
  const ran = checks.filter((c) => c.next === 'pass');
  if (ran.length === 0) return { ...base, decision: 'not-run' };
  if (row.kind !== 'fix') return { ...base, decision: 'passes' };
  if (ran.some((c) => c.prev === 'fail')) return { ...base, decision: 'negative' };
  if (ran.some((c) => c.prev === 'missing')) return { ...base, decision: 'prev-not-run' };
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

export function diffSuites(base, next) {
  const out = {
    regressed: [],
    newFailing: [],
    fixed: [],
    stillFailing: [],
    removed: [],
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
  for (const k of base.keys()) if (!next.has(k)) out.removed.push({ test: k });
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
      kind: 'compat-regression',
      package: 'unknown',
      spec: '',
      rerun: 'none',
      error: `kernel-compat ${compat.conclusion}`,
    });
  }
  return out;
}

export function knownAsOf(issue, { fixedBefore, releasedAt, version, fixedIn }) {
  if (fixedIn) return compareVersions(version, fixedIn) < 0;
  if (issue.state === 'OPEN' || issue.state === 'open') return true;
  if (issue.stateReason === 'NOT_PLANNED' || issue.stateReason === 'DUPLICATE') return false;
  const fixes = (issue.closedBy ?? []).filter((pr) => pr.merged && pr.mergeCommit);
  if (fixes.length > 0) return !fixes.some((pr) => fixedBefore(pr.mergeCommit));
  return Boolean(releasedAt && issue.closedAt && releasedAt < issue.closedAt);
}
