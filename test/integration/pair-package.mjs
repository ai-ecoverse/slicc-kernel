export const PAIR_ROOT = '/node_modules/pairtest';

export const PAIR_MANIFEST = JSON.stringify({
  name: 'pairtest',
  private: true,
  slicc: {
    abi: 'wasi',
    commands: { pairtest: { wasm: 'bin/pairtest.wasm', imports: 'host/pair.mjs' } },
  },
});

export const pairHost = (n) =>
  `export function createImports() {\n  return { pair: { v${n}: () => ${n} } };\n}\n`;

const text = (s) => [s.length, ...new TextEncoder().encode(s)];
const section = (id, bytes) => [id, bytes.length, ...bytes];

export function pairWasm(n) {
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, [3, 0x60, 1, 0x7f, 0, 0x60, 0, 1, 0x7f, 0x60, 0, 0]),
    ...section(2, [
      2,
      ...text('wasi_snapshot_preview1'),
      ...text('proc_exit'),
      0x00,
      0,
      ...text('pair'),
      ...text(`v${n}`),
      0x00,
      1,
    ]),
    ...section(3, [1, 2]),
    ...section(5, [1, 0x00, 1]),
    ...section(7, [2, ...text('memory'), 0x02, 0, ...text('_start'), 0x00, 2]),
    ...section(10, [1, 6, 0, 0x10, 1, 0x10, 0, 0x0b]),
  ]);
}

export const PAIR_FILES = (n) => [
  ['package.json', PAIR_MANIFEST],
  ['bin/pairtest.wasm', pairWasm(n)],
  ['host/pair.mjs', pairHost(n)],
];
