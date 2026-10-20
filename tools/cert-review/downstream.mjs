import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { DOWNSTREAM_OK, downstreamOf, verdict } from './lib.mjs';

const { values } = parseArgs({
  options: {
    result: { type: 'string', default: '' },
    bios: { type: 'string', default: '' },
    shards: { type: 'string', default: '' },
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
const result = values.result && existsSync(values.result) ? read(values.result) : undefined;
const shards = values.shards
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const found = downstreamOf(result, { biosRef: values.bios, shards });
if (values.out) {
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(found, null, 2)}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${found.line}\n`);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `state=${found.state}\nline=${found.line.slice(0, 900)}\n`
  );
for (const n of found.notify) console.log(`::warning title=downstream::${n}`);
const ok = DOWNSTREAM_OK.has(found.state);
verdict('downstream', ok, found.line);
process.exit(ok ? 0 : 1);
