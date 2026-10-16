#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const text = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'instructions.txt'),
  'utf8'
);
const env = {
  ...process.env,
  PLANTED_NOTE: process.env.PLANTED
    ? ` (planted: a build of the branch ${process.env.PLANTED}, not the npm package; review it exactly as a release, it is never certified)`
    : '',
};
process.stdout.write(text.replace(/\$([A-Z_]+)/g, (m, k) => env[k] ?? m));
