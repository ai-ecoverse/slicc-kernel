#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { sameDist, verdict } from './lib.mjs';

const { values } = parseArgs({
  options: {
    candidate: { type: 'string' },
    base: { type: 'string' },
    'candidate-version': { type: 'string' },
    'base-version': { type: 'string' },
    out: { type: 'string' },
  },
});

function unpack(tgz, version) {
  const dir = mkdtempSync(join(tmpdir(), 'cert-same-'));
  execFileSync('tar', ['-xzf', tgz, '-C', dir]);
  const files = new Map();
  const walk = (at) => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      const stat = lstatSync(path);
      const name = relative(join(dir, 'package'), path);
      if (stat.isDirectory()) walk(path);
      else
        files.set(name, {
          type: stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other',
          mode: stat.mode & 0o777,
          bytes: stat.isSymbolicLink()
            ? Buffer.from(readlinkSync(path))
            : stat.isFile()
              ? readFileSync(path)
              : Buffer.alloc(0),
        });
    }
  };
  walk(join(dir, 'package'));
  const sha256 = createHash('sha256').update(readFileSync(tgz)).digest('hex');
  return { files, version, sha256 };
}

const candidate = unpack(values.candidate, values['candidate-version']);
const base = unpack(values.base, values['base-version']);
const { identical, differences } = sameDist(candidate, base);
const evidence = {
  identical,
  candidate: { version: candidate.version, sha256: candidate.sha256, files: candidate.files.size },
  base: { version: base.version, sha256: base.sha256, files: base.files.size },
  differences: differences.slice(0, 50),
  rule: "identical dist: only package.json or its lock changed, and the packed candidate ships the same files, types, modes and bytes as the packed base, ignoring package.json devDependencies, version and gitHead and each side's exact version string",
  line: identical
    ? `not behaviour (identical dist): ${candidate.sha256.slice(0, 12)} = ${base.sha256.slice(0, 12)} after normalising ${candidate.version}/${base.version}`
    : `the dist differs: ${differences.slice(0, 3).join('; ')}${differences.length > 3 ? ` and ${differences.length - 3} more` : ''}`,
};
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(evidence.line);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `identical=${identical}\n`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${evidence.line}\n`);
verdict('same', true, `identical=${identical}: ${evidence.line}`);
