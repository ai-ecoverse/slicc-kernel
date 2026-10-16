#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { gateOf, NAME, publishStep } from './lib.mjs';
import { manifestOf, sha, sri } from './tarball.mjs';

const { values } = parseArgs({
  options: {
    tarball: { type: 'string', default: '' },
    record: { type: 'string', default: '' },
    sha256: { type: 'string', default: '' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const dryRun = values['dry-run'];
const say = (text) => {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${text}\n\`\`\`\n`);
};
const output = (outcome) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${outcome}\n`);
};
const env = { ...process.env };
for (const k of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NPM_CONFIG_TOKEN']) delete env[k];
const view = (field) => {
  try {
    return execFileSync('npm', ['view', ...field, '--prefer-online'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    }).trim();
  } catch {
    return '';
  }
};

const tarball = existsSync(values.tarball) ? values.tarball : '';
const record = existsSync(values.record)
  ? JSON.parse(readFileSync(values.record, 'utf8'))
  : undefined;
const gate = tarball
  ? gateOf({
      record,
      sha256: sha('sha256', tarball),
      packed: values.sha256,
      manifest: manifestOf(tarball),
    })
  : { subject: NAME, why: 'no tarball' };
if (gate.why) {
  say(`refuse to publish ${gate.subject}: ${gate.why}${gate.line ? `\n${gate.line}` : ''}`);
  output('refused');
  console.log(`::error title=not published::${gate.subject}: ${gate.why}`);
  process.exit(2);
}
const { version } = record;
const latest = view([NAME, 'dist-tags.latest']);
const onNpm = view([`${NAME}@${version}`, 'dist.integrity']);
const ours = sri(tarball);
const step = publishStep({ version, latest, onNpm, ours, dryRun });
const head = `${dryRun ? 'dry run: ' : ''}${gate.subject} sha256=${gate.sha256} (npm latest ${latest || 'none'})\n${gate.line}`;
const args = ['publish', tarball, '--provenance', '--access', 'public', '--tag', 'latest'];
if (step.action === 'skip') {
  say(`${head}\nskip, not published to npm: ${step.why}`);
  output('skipped');
  if (dryRun) {
    console.log('the dry run still runs the publish command, as a check of the bytes:');
    execFileSync('npm', [...args, '--dry-run', '--force'], { stdio: 'inherit', env });
  }
  process.exit(0);
}
if (step.action === 'refuse') {
  say(`${head}\nrefuse: ${step.why}`);
  output('refused');
  console.log(`::error title=not published::${step.why}`);
  process.exit(2);
}
if (step.action === 'done') {
  say(`${head}\n${step.why}`);
  output('published');
  process.exit(0);
}
if (dryRun) args.push('--dry-run');
if (step.force) args.push('--force');
say(`${head}\n${step.why ? `${step.why}\n` : ''}npm ${args.join(' ')}`);
for (let attempt = 1; ; attempt++) {
  try {
    execFileSync('npm', args, { stdio: 'inherit', env });
    break;
  } catch (error) {
    if (!dryRun && view([`${NAME}@${version}`, 'dist.integrity']) === ours) break;
    if (dryRun || attempt >= 4) throw error;
    console.log(`npm publish failed (attempt ${attempt}), retrying in ${15 * 2 ** attempt} s`);
    await new Promise((done) => setTimeout(done, 15_000 * 2 ** attempt));
  }
}
output(dryRun ? 'dry-run' : 'published');
