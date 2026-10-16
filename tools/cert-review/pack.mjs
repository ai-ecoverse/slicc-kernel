#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sha, sri } from './tarball.mjs';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    ref: { type: 'string', default: '' },
    out: { type: 'string' },
  },
});
const { version } = values;
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !values.out) {
  console.error('pack: --version x.y.z and --out <dir> are required');
  process.exit(2);
}
const ref = values.ref || `v${version}`;
const out = resolve(values.out);
const tree = join(out, 'tree');
const dest = join(out, 'tgz');
const env = { ...process.env, LEFTHOOK: '0' };
const sh = (cmd, args, cwd) => {
  console.log(`${cwd ? `(${cwd}) ` : ''}${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
};
rmSync(tree, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
sh('git', ['worktree', 'add', '--force', '--detach', tree, `${ref}^{commit}`]);
const commit = sh('git', ['rev-parse', 'HEAD'], tree).trim();
sh('npm', ['ci', '--no-audit', '--no-fund'], tree);
sh('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], tree);
sh('npm', ['pkg', 'set', `gitHead=${commit}`], tree);
sh('npm', ['pack', '--silent', '--pack-destination', dest], tree);
const made = readdirSync(dest).filter((f) => f.endsWith('.tgz'));
if (made.length !== 1) throw new Error(`npm pack made ${made.length} tarballs`);
const file = join(out, made[0]);
renameSync(join(dest, made[0]), file);
const sha256 = sha('sha256', file);
writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
const facts = { version, ref, commit, file: basename(file), sha256, integrity: sri(file) };
writeFileSync(join(out, 'pack.json'), `${JSON.stringify(facts, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `sha256=${sha256}\nfile=${basename(file)}\ncommit=${commit}\n`
  );
}
console.log(`pack: ${basename(file)} sha256=${sha256} from ${ref} (${commit})`);
