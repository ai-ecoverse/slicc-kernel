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
    const raw = m[1] === '`' ? m[2].replace(/\$\{[^}]*\}?/g, PREFIX) : m[2];
    const title = unquote(raw).replace(/\u2026+/g, PREFIX);
    if (title.replaceAll(PREFIX, '').trim() === '') continue;
    titles.add(m[3] === undefined && !title.endsWith(PREFIX) ? `${title}${PREFIX}` : title);
  }
  return [...titles];
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
  for (const r of rows.filter((x) => x.kind === 'fix' && x.tests.length > 0)) {
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

const GAPS = new Set(['no-test', 'no-negative', 'prev-not-run', 'no-titles', 'not-run']);

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
  attempt = 1,
}) {
  const tag = `${name}@${version}${planted ? ` (planted ${planted})` : ''}`;
  if (problems.length === 0 && !incomplete && review?.verdict === 'certified') {
    return { state: 'success', line: certified };
  }
  if (incomplete && problems.length === 0) {
    if (Number(attempt) > 1) {
      return {
        state: 'error',
        line: `cert-ci: NOT REVIEWED ${tag}: still incomplete after a retry (${incomplete.named}); not published (${ci})`,
      };
    }
    return {
      state: 'error',
      line: `cert-ci: INCOMPLETE ${tag} (${incomplete.named}; ${incomplete.remedy}) (${ci})`,
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

export const NAME = '@ai-ecoverse/slicc-kernel';
const SEMVER = /^\d+\.\d+\.\d+$/;

export function gateOf({ record, sha256, packed, manifest }) {
  const version = String(record?.version ?? '');
  const line = String(record?.line ?? '').split('\n')[0];
  const subject = SEMVER.test(version) ? `${NAME}@${version}` : NAME;
  const refuse = (why) => ({ subject, line, why });
  if (!record) return refuse('no cert-review record');
  if (!SEMVER.test(version)) return refuse(`the record's version is "${version}"`);
  if (record.planted) return refuse(`the record is for a planted build of ${record.planted}`);
  if (record.certified !== true || !line.startsWith(`certified ${subject} `))
    return refuse('the verdict is not certified');
  if (record.sha256 !== sha256)
    return refuse(`the record's sha256 ${record.sha256} is not the tarball's ${sha256}`);
  if (String(packed ?? '').trim() !== sha256)
    return refuse(`the pack job's sha256 ${packed || '(none)'} is not the tarball's ${sha256}`);
  if (!line.startsWith(`certified ${subject} sha256=${sha256} `))
    return refuse("the line doesn't name the tarball's sha256");
  if (manifest?.name !== NAME || manifest?.version !== version)
    return refuse(`the tarball is ${manifest?.name}@${manifest?.version}`);
  return { subject, line, sha256 };
}

export function publishStep({ version, latest, onNpm, ours, dryRun }) {
  if (!SEMVER.test(latest ?? ''))
    return {
      action: 'refuse',
      why: `npm's latest reads as "${latest ?? ''}", so the latest check can't run`,
    };
  if (compareVersions(version, latest) < 0)
    return { action: 'skip', why: `v${version} is older than npm's latest ${latest}` };
  if (onNpm && dryRun)
    return {
      action: 'publish',
      force: true,
      why: `${NAME}@${version} is already on npm (${onNpm === ours ? 'these bytes' : onNpm}), so the dry run adds --force`,
    };
  if (onNpm && onNpm !== ours)
    return { action: 'refuse', why: `${NAME}@${version} is on npm as ${onNpm}, not ${ours}` };
  if (onNpm)
    return { action: 'done', why: `${NAME}@${version} is already on npm with these bytes` };
  return { action: 'publish', force: false };
}

export function packageProblems(manifest, { version, commit }) {
  const problems = [];
  if (manifest?.name !== NAME || manifest?.version !== version)
    problems.push(`the tarball is ${manifest?.name}@${manifest?.version}, not ${NAME}@${version}`);
  if (manifest?.gitHead !== commit)
    problems.push(`the tarball's gitHead is ${manifest?.gitHead}, the tag commit is ${commit}`);
  return problems;
}

export function previousPublished(tags, published, version) {
  const served = new Set(published);
  return tags
    .filter((t) => served.has(t) && compareVersions(t, version) < 0)
    .sort(compareVersions)
    .at(-1);
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

export function retryDecision({ attempt, state, active }) {
  if (Number(attempt) !== 1)
    return { retry: false, why: `attempt ${attempt}: only attempt 1 is retried` };
  if (state !== 'error')
    return { retry: false, why: `the cert-review status is ${state || 'missing'}, not error` };
  if (active > 0)
    return {
      retry: false,
      why: `${active} newer Release run(s) waiting or running; a re-run would cancel one`,
    };
  return { retry: true, why: 'INCOMPLETE on attempt 1: re-run the failed jobs once' };
}
