import { readFile, writeFile } from 'node:fs/promises';
import wabt from 'wabt';

const here = new URL('./', import.meta.url);
const tools = await wabt();
const text = await readFile(new URL('hostcall.wat', here), 'utf8');
const module = tools.parseWat('hostcall.wat', text);
await writeFile(new URL('bin/hostcall.wasm', here), module.toBinary({}).buffer);
