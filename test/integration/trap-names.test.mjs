import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeKernel } from '../../dist/node.js';

const enc = new TextEncoder();
const str = (x) => [enc.encode(x).length, ...enc.encode(x)];
const section = (id, body) => [id, body.length, ...body];
const MODULE = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
  ...section(1, [1, 0x60, 0, 0]),
  ...section(3, [2, 0, 0]),
  ...section(5, [1, 0, 1]),
  ...section(7, [2, ...str('memory'), 2, 0, ...str('_start'), 0, 0]),
  ...section(10, [2, 4, 0, 0x10, 1, 0x0b, 3, 0, 0x00, 0x0b]),
]);
const sidecar = (names) => {
  const fns = [names.length, ...names.flatMap((n, i) => [i, ...str(n)])];
  return new Uint8Array([1, fns.length, ...fns]);
};

test("a backtrace names sidecar that doesn't fit the module prints one warning and shows raw indices instead of wrong names; one that fits names the frames (#1239, homescoop#1095)", async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  const env = { SLICC_WASM_BACKTRACE: '1' };
  await kernel.writeFile('/home/fit/trap.wasm', MODULE, { mode: 0o755 });
  await kernel.writeFile('/home/fit/trap.wasm.names', sidecar(['_start', 'boom']));
  const fits = await kernel.run(['/home/fit/trap.wasm'], { cwd: '/', env });
  assert.equal(fits.status, 134);
  assert.match(fits.stderr, /^trap: wasm trap: unreachable\n/);
  assert.match(fits.stderr, /at boom \(wasm:\/\/wasm\/[^)]*wasm-function\[1\]/);
  assert.doesNotMatch(fits.stderr, /doesn't fit/);

  await kernel.writeFile('/home/off/trap.wasm', MODULE, { mode: 0o755 });
  await kernel.writeFile('/home/off/trap.wasm.names', sidecar(['_start', 'boom', 'extra']));
  const off = await kernel.run(['/home/off/trap.wasm'], { cwd: '/', env });
  assert.equal(off.status, 134);
  const warnings = off.stderr.split('\n').filter((l) => l.includes("doesn't fit"));
  assert.deepEqual(warnings, [
    "trap: /home/off/trap.wasm.names names 3 functions, but the module has 2: it doesn't fit, so the frames show raw indices",
  ]);
  assert.match(off.stderr, /\ntrap: wasm trap: unreachable\n/);
  assert.match(off.stderr, /at wasm:\/\/wasm\/[^\s]*wasm-function\[1\]/);
  assert.doesNotMatch(off.stderr, /at (boom|_start|extra) \(/);
});
