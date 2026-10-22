import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel, memoryRoot } from '../../dist/node.js';

const MIB = 1024 * 1024;
const CAP = 18 * MIB;

function syncHandle(target, persisted) {
  return async () => {
    await persisted.done;
    let bytes = new Uint8Array(await (await target.getFile()).arrayBuffer());
    const store = () => {
      const kept = bytes.slice(0, Math.min(bytes.length, CAP));
      persisted.done = persisted.done.then(async () => {
        const writable = await target.createWritable();
        await writable.write(kept);
        await writable.close();
      });
    };
    return {
      write: (data, { at }) => {
        const end = at + data.length;
        if (end > bytes.length) {
          const grown = new Uint8Array(end);
          grown.set(bytes);
          bytes = grown;
        }
        bytes.set(data, at);
        return data.length;
      },
      truncate: (size) => {
        const next = new Uint8Array(size);
        next.set(bytes.subarray(0, Math.min(size, bytes.length)));
        bytes = next;
      },
      getSize: () => Math.min(bytes.length, CAP),
      flush: store,
      close: () => undefined,
    };
  };
}

function capped(file, sync) {
  const persisted = { done: Promise.resolve() };
  return new Proxy(file, {
    get(target, key) {
      if (sync && key === 'createSyncAccessHandle') return syncHandle(target, persisted);
      if (key === 'getFile')
        return async () => {
          await persisted.done;
          return target.getFile();
        };
      if (key !== 'createWritable') {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (options) => {
        await persisted.done;
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

function cappedDir(dir, sync = false) {
  const files = new Map();
  const file = (h) => {
    if (!files.has(h)) files.set(h, capped(h, sync));
    return files.get(h);
  };
  return new Proxy(dir, {
    get(target, key) {
      if (key === 'getDirectoryHandle')
        return async (...args) => cappedDir(await target.getDirectoryHandle(...args), sync);
      if (key === 'getFileHandle')
        return async (...args) => file(await target.getFileHandle(...args));
      if (key === 'values')
        return async function* () {
          for await (const h of target.values())
            yield h.kind === 'file' ? file(h) : cappedDir(h, sync);
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
    if (mode === 'whole') await ctx.fs.writeFile(path, new Uint8Array(24 * ${MIB}).fill(7));
    else if (mode === 'truncate') await f.truncate(24 * ${MIB});
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

async function quotaKernel(t, sync) {
  const kernel = await createNodeKernel({ root: cappedDir(memoryRoot(), sync) });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/quota/package.json',
    JSON.stringify({
      name: 'quota',
      slicc: { commands: { quota: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/quota/main.mjs', PROGRAM);
  const run = (mode) => kernel.run(['quota', mode, `/tmp/${mode}.bin`], { cwd: '/' });
  run.kernel = kernel;
  return run;
}

function lost(r, mode, where) {
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.trim();
  assert.ok(Number(/size (\d+)$/.exec(line)?.[1]) <= CAP, line);
  assert.match(line, where, `${mode}: ${line}`);
}

test('bytes the root does not store past its quota fail a write, a sync or the close with ENOSPC, never a silent success (#1430)', {
  timeout: 300_000,
}, async (t) => {
  const run = await quotaKernel(t, false);
  for (const mode of ['write', 'truncate']) lost(await run(mode), mode, /close ENOSPC/);
  lost(await run('whole'), 'whole', /write ENOSPC/);
  await assert.rejects(run.kernel.writeFile('/tmp/embedded.bin', new Uint8Array(24 * MIB)), {
    code: 'ENOSPC',
  });
});

test('bytes a sync access handle does not store past its quota fail the write-back with ENOSPC too (#1430 review)', {
  timeout: 300_000,
}, async (t) => {
  const run = await quotaKernel(t, true);
  for (const mode of ['write', 'truncate']) lost(await run(mode), mode, /close ENOSPC/);
});
