#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const text = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'instructions.txt'),
  'utf8'
);
process.stdout.write(text.replace(/\$([A-Z_]+)/g, (m, k) => process.env[k] ?? m));
