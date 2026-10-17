#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { mergeRetry, parseResults, testCommand, unfinishedFiles, verdict } from './lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    tree: { type: 'string' },
    tgz: { type: 'string' },
    out: { type: 'string' },
    files: { type: 'string', default: '' },
    timeout: { type: 'string', default: '90' },
  },
});
const tree = resolve(values.tree);
const out = resolve(values.out);
function inSession(command, { cwd, env, timeoutMs, log, onTerm: terminated }) {
  return new Promise((done) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ignored = [];
    child.stdout.on('data', (b) => writeSync(log, b));
    child.stderr.on('data', (b) => writeSync(log, b));
    const group = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      group('SIGTERM');
    }, timeoutMs);
    const onInt = () => ignored.push('SIGINT');
    const onTerm = () => {
      group('SIGTERM');
      terminated(ignored);
      process.exit(143);
    };
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    child.once('error', (error) => {
      clearTimeout(timer);
      done({ status: null, error, ignored });
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      done({
        status,
        signal,
        error: timedOut ? { code: 'ETIMEDOUT' } : undefined,
        ignored,
      });
    });
  });
}

function swapDist(tgz) {
  const unpacked = mkdtempSync(join(tmpdir(), 'cert-dist-'));
  try {
    const tar = spawnSync('tar', ['-xzf', tgz, '-C', unpacked], { stdio: 'inherit' });
    if (tar.status !== 0) throw new Error(`tar -xzf ${tgz} failed`);
    rmSync(join(tree, 'dist'), { recursive: true, force: true });
    cpSync(join(unpacked, 'package', 'dist'), join(tree, 'dist'), { recursive: true });
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
}

swapDist(resolve(values.tgz));
mkdirSync(dirname(out), { recursive: true });
const results = `${out}.jsonl`;
rmSync(results, { force: true });
const files = values.files ? values.files.split(',').filter(Boolean) : [];
const script = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')).scripts?.test ?? '';
const command = testCommand(script, join(here, 'reporter.mjs'), results, files);
console.log(`suite: (${tree}) ${command}`);
const started = Date.now();
const env = { ...process.env, NODE_NO_WARNINGS: '1' };
for (const k of ['AWS_BEARER_TOKEN_BEDROCK', 'GH_TOKEN', 'GITHUB_TOKEN', 'NODE_TEST_CONTEXT'])
  delete env[k];
const log = openSync(`${out}.log`, 'w');
const retryResults = `${out}.retry.jsonl`;
rmSync(retryResults, { force: true });
const expected = files.length
  ? files
  : readdirSync(join(tree, 'test/integration'))
      .filter((f) => f.endsWith('.test.mjs'))
      .map((f) => `test/integration/${f}`);
const readRows = (file) => {
  try {
    return parseResults(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
};
let retried = [];
let firstExit;
function finish(exit, ignored) {
  const first = readRows(results);
  const rows = retried.length ? mergeRetry(first, readRows(retryResults), retried) : first;
  const unfinished = unfinishedFiles(expected, rows);
  const healed = retried.length > 0 && unfinished.length === 0;
  const failed = rows.some((r) => r.status === 'fail' || r.status === 'cancelled');
  const count = (status) => rows.filter((r) => r.status === status).length;
  const summary = {
    tree,
    tgz: resolve(values.tgz),
    files,
    expected,
    exit: healed ? (failed ? 1 : 0) : exit,
    ...(retried.length ? { retried, firstExit } : {}),
    unfinished,
    ...(ignored.length ? { ignored } : {}),
    seconds: Math.round((Date.now() - started) / 1000),
    pass: count('pass'),
    fail: count('fail') + count('cancelled'),
    skip: count('skip') + count('todo'),
    results: rows,
  };
  closeSync(log);
  writeFileSync(`${out}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  verdict(
    'suite',
    summary.exit === 0 && summary.fail === 0 && unfinished.length === 0,
    `exit ${summary.exit}, pass ${summary.pass}, fail ${summary.fail}, skip ${summary.skip}, ${unfinished.length} files without results: evidence in ${out}.json`
  );
  return summary;
}
const exitOf = (run) =>
  run.error ? `error ${run.error.code}` : (run.status ?? `signal ${run.signal}`);
const session = {
  cwd: tree,
  env,
  timeoutMs: Number(values.timeout) * 60_000,
  log,
  onTerm: (ignored) => finish('signal SIGTERM', ignored),
};
const run = await inSession(command, session);
const ignored = [...run.ignored];
const again = unfinishedFiles(expected, readRows(results));
if (again.length > 0 && !run.error) {
  firstExit = exitOf(run);
  retried = again;
  const retry = testCommand(script, join(here, 'reporter.mjs'), retryResults, again);
  writeSync(log, `\nsuite: retrying ${again.length} files without results: ${again.join(' ')}\n`);
  console.log(`suite: retrying ${again.length} files without results: ${again.join(' ')}`);
  const second = await inSession(retry, session);
  ignored.push(...second.ignored);
  run.status = second.status;
  run.signal = second.signal;
  run.error = second.error;
}
const summary = finish(exitOf(run), ignored);
console.log(
  `suite: exit ${summary.exit}, pass ${summary.pass}, fail ${summary.fail}, skip ${summary.skip}, ${summary.seconds}s${summary.unfinished.length ? `, ${summary.unfinished.length} files without results` : ''}`
);
