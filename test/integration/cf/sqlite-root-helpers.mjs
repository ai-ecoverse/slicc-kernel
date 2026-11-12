import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, memoryRoot } from '../../../dist/node.js';
import { sqliteMeta } from '../../../src/cloudflare/sqlite-meta.ts';
import { sqliteRoot } from '../../../src/cloudflare/sqlite-root.ts';
import { sqliteFlush } from '../../../src/cloudflare/sqlite-store.ts';

const modules = new URL('../../../node_modules/@ai-ecoverse/', import.meta.url);

export const PACKAGES = ['wasm-bash', 'wasm-coreutils'];

export const BASELINE = [
  ['echo hi', 'hi\n'],
  ['echo a | cat; echo sub=$(echo hi); ls / | head -3', 'a\nsub=hi\nbin\ndev\netc\n'],
  ['for i in 1 2 3; do echo $i; done | wc -l; false; echo rc=$?', '3\nrc=1\n'],
  ['echo data > /tmp/f; cat /tmp/f; (sleep 0.1; echo bg) & wait; echo done', 'data\nbg\ndone\n'],
];

export async function install(kernel, names = PACKAGES) {
  for (const name of names) {
    const base = new URL(`${name}/`, modules);
    const entries = await readdir(base, { recursive: true, withFileTypes: true });
    for (const entry of entries.filter((e) => e.isFile())) {
      const file = join(entry.parentPath, entry.name);
      await kernel.writeFile(
        `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
        await readFile(file)
      );
    }
  }
}

export const MODES = [
  ['write-through', {}],
  ['write-behind', { writeBehind: true }],
];

export function sqliteKernel(sql, options = {}, sqlite = {}) {
  return createNodeKernel({
    root: sqliteRoot(sql, sqlite),
    meta: sqliteMeta(sql, sqlite),
    ranged: true,
    ...options,
  });
}

export function closeSql(sql) {
  sqliteFlush(sql);
  sql.close();
}

export function memoryKernel(options = {}) {
  return createNodeKernel({ root: memoryRoot(), ...options });
}

export function bash(kernel, script, options = {}) {
  return kernel.run(['bash', '-c', script], { cwd: '/', ...options });
}
