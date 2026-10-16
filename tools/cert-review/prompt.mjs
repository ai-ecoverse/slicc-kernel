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
  PR_NOTE: process.env.PR
    ? ` (pull request #${process.env.PR}, reviewed before it merges: v${process.env.VERSION} is this pull request's own build, packed from the pull request merged onto main at review time, and v${process.env.PREV} is main's build at the pull request's base, packed in the same run. Read "release" as this build, "published dist" as the packed one, and "previous release" as main's build. Only a certified pull request merges, so main and npm's latest carry only certified changes. A removed or renamed test that the pull request's body explains is deliberate.)`
    : '',
};
process.stdout.write(text.replace(/\$([A-Z_]+)/g, (m, k) => env[k] ?? m));
