import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(base, file)}`,
      await readFile(file)
    );
  }
}

const HTTPD = `export default async function main(ctx) {
  const l = await ctx.net.listen({ port: 8099 });
  await ctx.fs.writeFile('/tmp/httpd-ready', '');
  const c = await l.accept();
  const r = c.readable.getReader();
  await r.read();
  const w = c.writable.getWriter();
  await w.write(new TextEncoder().encode('HTTP/1.1 200 OK\\r\\nContent-Length: 6\\r\\nConnection: close\\r\\n\\r\\nserved'));
  await w.close();
  await c.close();
  await l.close();
}
`;

const CASES = [
  ['cat', 'printf "a\\nb\\n" > /tmp/f; cat /tmp/f', 'a\nb\n'],
  ['head', 'printf "1\\n2\\n3\\n" | head -n 2', '1\n2\n'],
  ['pipeline', 'printf "x y z\\n" | tr " " "\\n" | sort -r | cat', 'z\ny\nx\n'],
  ['echo', 'echo hi', 'hi\n'],
  ['stderr', 'echo oops >&2; cat /nope', ''],
  [
    'curl',
    'rm -f /tmp/httpd-ready; httpd & until [ -e /tmp/httpd-ready ]; do :; done; curl -s http://127.0.0.1:8099/; wait',
    'served',
  ],
];

test('a client gets every Emscripten stdout and stderr chunk as a Uint8Array, never an Int8Array view of the heap (#1099)', {
  timeout: 180_000,
}, async (t) => {
  const kernel = await createNodeKernel();
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-curl']) await install(kernel, name);
  await kernel.writeFile(
    '/node_modules/httpd/package.json',
    JSON.stringify({
      name: 'httpd',
      slicc: { commands: { httpd: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/httpd/main.mjs', HTTPD);
  const client = await attachKernel(await kernel.connect());
  t.after(() => client.close());
  for (const [name, script, expected] of CASES) {
    const chunks = [];
    const child = await client.spawn(['bash', '-c', script], {
      cwd: '/',
      onStdout: (b) => chunks.push(['out', b]),
      onStderr: (b) => chunks.push(['err', b]),
    });
    await child.exited;
    assert.ok(chunks.length > 0, name);
    for (const [, b] of chunks) {
      assert.equal(
        Object.prototype.toString.call(b),
        '[object Uint8Array]',
        `${name}: ${b?.constructor?.name}`
      );
      assert.ok(b instanceof Uint8Array && !(b instanceof Int8Array), name);
    }
    const out = Buffer.concat(chunks.filter(([k]) => k === 'out').map(([, b]) => b)).toString();
    assert.equal(out, expected, name);
    if (name === 'stderr') assert.ok(chunks.some(([k]) => k === 'err'));
  }
});
