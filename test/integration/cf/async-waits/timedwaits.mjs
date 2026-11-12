import { readFile } from 'node:fs/promises';
import wabt from 'wabt';

export const PACKAGE = {
  name: 'timedwaits',
  private: true,
  slicc: { abi: 'wasi', commands: { timedwaits: { wasm: 'bin/timedwaits.wasm' } } },
};

export const ROUNDS = 4;
export const WAIT_MS = 250;

export async function timedwaitsWasm() {
  const text = await readFile(new URL('./timedwaits.wat', import.meta.url), 'utf8');
  const tools = await wabt();
  return new Uint8Array(
    tools.parseWat('timedwaits.wat', text, { threads: true }).toBinary({}).buffer
  );
}

export async function installTimedwaits(write) {
  await write('/node_modules/timedwaits/package.json', JSON.stringify(PACKAGE));
  await write('/node_modules/timedwaits/bin/timedwaits.wasm', await timedwaitsWasm());
}

export function parsed(stdout) {
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [kind, ms, errno, extra] = line.split(' ');
      return { kind, ms: Number(ms), errno: Number(errno), extra: Number(extra) };
    });
}
