#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseResults, testCommand } from './lib.mjs';

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
function inSession(command, { cwd, env, timeoutMs }) {
  return new Promise((done) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    const ignored = [];
    child.stdout.on('data', (b) => chunks.push(b));
    child.stderr.on('data', (b) => chunks.push(b));
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
      process.exit(143);
    };
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    child.once('error', (error) => {
      clearTimeout(timer);
      done({ status: null, error, output: '', ignored });
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      done({
        status,
        signal,
        error: timedOut ? { code: 'ETIMEDOUT' } : undefined,
        output: Buffer.concat(chunks).toString('utf8'),
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
const run = await inSession(command, {
  cwd: tree,
  env,
  timeoutMs: Number(values.timeout) * 60_000,
});
writeFileSync(`${out}.log`, run.output);
let rows = [];
try {
  rows = parseResults(readFileSync(results, 'utf8'));
} catch {}
const count = (s) => rows.filter((r) => r.status === s).length;
const summary = {
  tree,
  tgz: resolve(values.tgz),
  files,
  exit: run.error ? `error ${run.error.code}` : (run.status ?? `signal ${run.signal}`),
  ...(run.ignored.length ? { ignored: run.ignored } : {}),
  seconds: Math.round((Date.now() - started) / 1000),
  pass: count('pass'),
  fail: count('fail') + count('cancelled'),
  skip: count('skip') + count('todo'),
  results: rows,
};
writeFileSync(`${out}.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  `suite: exit ${summary.exit}, pass ${summary.pass}, fail ${summary.fail}, skip ${summary.skip}, ${summary.seconds}s`
);
