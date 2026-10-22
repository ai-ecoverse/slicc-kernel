import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, memoryRoot } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
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

const locked = new Set();
const busy = () => new DOMException('locked', 'NoModificationAllowedError');

function lockable(root) {
  const seen = new WeakMap();
  const wrap = (handle) => {
    if (seen.has(handle)) return seen.get(handle);
    const proxy = new Proxy(handle, {
      get(target, key) {
        if (target.kind === 'file' && key === 'move')
          return async (...args) => {
            if (locked.has(target)) throw busy();
            return target.move(...args);
          };
        if (target.kind === 'directory') {
          if (key === 'getDirectoryHandle' || key === 'getFileHandle')
            return async (...args) => wrap(await target[key](...args));
          if (key === 'removeEntry')
            return async (name, options) => {
              const child = await target.getFileHandle(name).catch(() => undefined);
              if (child && locked.has(child)) throw busy();
              return target.removeEntry(name, options);
            };
          if (key === 'values')
            return async function* () {
              for await (const child of target.values()) yield wrap(child);
            };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    seen.set(handle, proxy);
    return proxy;
  };
  return { root: wrap(root), raw: root };
}

test('a rename whose source file another holder keeps locked fails with EBUSY and leaves no copy at the destination (#1449)', {
  timeout: 300_000,
}, async (t) => {
  const { root, raw } = lockable(memoryRoot());
  const kernel = await createNodeKernel({ root });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile('/tmp/a', 'data\n');
  const file = await (await raw.getDirectoryHandle('tmp')).getFileHandle('a');
  locked.add(file);
  const r = await kernel.run(['bash', '-c', 'mv /tmp/a /tmp/b; echo mv=$?; ls /tmp; cat /tmp/a'], {
    cwd: '/',
  });
  locked.delete(file);
  assert.match(r.stderr, /Resource busy/);
  assert.equal(r.stdout, 'mv=1\na\ndata\n');
  const after = await kernel.run(['bash', '-c', 'mv /tmp/a /tmp/b && ls /tmp && cat /tmp/b'], {
    cwd: '/',
  });
  assert.deepEqual(after, { status: 0, stdout: 'b\ndata\n', stderr: '' });
});
