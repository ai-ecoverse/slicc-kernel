import { sqliteFlush } from '../../../src/cloudflare/sqlite-store.ts';
import { sqlStorage } from './sqlite-root-adapter.mjs';
import { bash, sqliteKernel } from './sqlite-root-helpers.mjs';

const [path, emscripten, script] = process.argv.slice(2);
const sql = sqlStorage(path);
const kernel = await sqliteKernel(
  sql,
  { ...(emscripten === 'kernel' ? { emscripten: 'kernel' } : {}), durable: () => sqliteFlush(sql) },
  { writeBehind: { idleMs: 600000, maxMs: 600000 } }
);
await bash(kernel, `${script}; echo ready; sleep 1000`, {
  onStdout: (text) => {
    if (String(text).includes('ready')) process.stdout.write('ready\n');
  },
});
