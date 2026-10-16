import { readFile, writeFile } from 'node:fs/promises';
import wabt from 'wabt';

const here = new URL('./', import.meta.url);
const tools = await wabt();
const text = await readFile(new URL('killspin.wat', here), 'utf8');
const module = tools.parseWat('killspin.wat', text, { exceptions: true });
await writeFile(new URL('bin/killspin.wasm', here), module.toBinary({}).buffer);
