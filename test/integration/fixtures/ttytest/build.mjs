import { readFile, writeFile } from 'node:fs/promises';
import wabt from 'wabt';

const here = new URL('./', import.meta.url);
const tools = await wabt();
const text = await readFile(new URL('ttytest.wat', here), 'utf8');
const module = tools.parseWat('ttytest.wat', text, { bulk_memory: true });
await writeFile(new URL('bin/ttytest.wasm', here), module.toBinary({}).buffer);
