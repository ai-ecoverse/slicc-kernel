import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel, memoryRoot } from '../../dist/node.js';

const MIB = 1024 * 1024;
const CAP = 18 * MIB;

function capped(file) {
  return new Proxy(file, {
    get(target, key) {
      if (key !== 'createWritable') {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (options) => {
        const writable = await target.createWritable(options);
        return {
          write: (data) => writable.write(data),
          seek: (at) => writable.seek(at),
          abort: () => writable.abort(),
          truncate: (size) => writable.truncate(Math.min(size, CAP)),
          close: async () => {
            await writable.close();
            if ((await target.getFile()).size <= CAP) return;
            const cut = await target.createWritable({ keepExistingData: true });
            await cut.truncate(CAP);
            await cut.close();
          },
        };
      };
    },
  });
}

function cappedDir(dir) {
  return new Proxy(dir, {
    get(target, key) {
      if (key === 'getDirectoryHandle')
        return async (...args) => cappedDir(await target.getDirectoryHandle(...args));
      if (key === 'getFileHandle')
        return async (...args) => capped(await target.getFileHandle(...args));
      if (key === 'values')
        return async function* () {
          for await (const h of target.values()) yield h.kind === 'file' ? capped(h) : cappedDir(h);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const PROGRAM = `export default async function main(ctx) {
  const [, mode, path] = ctx.argv;
  const out = [];
  const f = await ctx.open(path, { write: true, create: true, truncate: true });
  let at = 0;
  try {
    if (mode === 'truncate') await f.truncate(24 * ${MIB});
    else {
      const chunk = new Uint8Array(${MIB}).fill(7);
      for (let i = 0; i < 24; i++) {
        at += await f.write(at, chunk);
        await f.sync();
      }
    }
    out.push('wrote');
  } catch (err) {
    out.push('write ' + err.code);
  }
  try {
    await f.close();
    out.push('closed');
  } catch (err) {
    out.push('close ' + err.code);
  }
  out.push('size ' + (await ctx.fs.stat(path)).size);
  await ctx.write(1, out.join(' ') + '\\n');
  return 0;
}`;

test('bytes the root does not store past its quota fail a write, a sync or the close with ENOSPC, never a silent success (#1430)', {
  timeout: 300_000,
}, async (t) => {
  const kernel = await createNodeKernel({ root: cappedDir(memoryRoot()) });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/quota/package.json',
    JSON.stringify({
      name: 'quota',
      slicc: { commands: { quota: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/quota/main.mjs', PROGRAM);
  for (const mode of ['write', 'truncate']) {
    const r = await kernel.run(['quota', mode, `/tmp/${mode}.bin`], { cwd: '/' });
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.trim();
    const size = Number(/size (\d+)$/.exec(line)?.[1]);
    assert.ok(size <= CAP, line);
    assert.match(line, /close ENOSPC/, `${mode}: ${line}`);
  }
});
