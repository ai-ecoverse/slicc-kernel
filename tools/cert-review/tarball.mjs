import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const sha = (algo, file, enc = 'hex') =>
  createHash(algo).update(readFileSync(file)).digest(enc);

export const sri = (file) => `sha512-${sha('sha512', file, 'base64')}`;

export function manifestOf(tgz) {
  return JSON.parse(
    execFileSync('tar', ['-xzf', tgz, '-O', 'package/package.json'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  );
}
