import { attachKernel, createNodeKernel } from '../../../dist/node.js';
import { asyncProcessEntry } from './async-link-process.mjs';

export const MODES = ['inline', 'thread', 'reordered'];

export const MODE_NAMES = {
  inline: 'a same-thread MessageChannel',
  thread: 'worker_threads',
  reordered: 'a same-thread link that delivers kernel posts late and out of order',
};

function reordering(link) {
  return {
    post: (message, transfer) => link.post(message, transfer),
    call: (message, transfer) => link.call(message, transfer),
    onClose: (handler) => link.onClose(handler),
    close: () => link.close(),
    onMessage(handler) {
      link.onMessage((message) => {
        if (message?.type === 'wasm-process-init') handler(message);
        else setTimeout(() => handler(message), Math.floor(Math.random() * 15));
      });
    },
  };
}

const processModule = new URL('./async-link-process.mjs', import.meta.url);

const MINIMAL_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

export async function asyncKernel(mode, extra = {}) {
  const asyncProcess = mode === 'inline' ? { inline: asyncProcessEntry } : { entry: processModule };
  const kernel = await createNodeKernel({
    blocking: 'async',
    asyncProcess: { ...asyncProcess, ...extra },
  });
  await kernel.writeFile(
    '/node_modules/fake/package.json',
    JSON.stringify({ slicc: { abi: 'wasi', commands: { fake: { wasm: 'fake.wasm' } } } })
  );
  await kernel.writeFile('/node_modules/fake/fake.wasm', MINIMAL_WASM);
  return kernel;
}

export async function clientOf(kernel) {
  return attachKernel(await kernel.connect());
}

export async function spawnReady(client, argv) {
  let text = '';
  const { promise: ready, resolve } = Promise.withResolvers();
  const decoder = new TextDecoder();
  const proc = await client.spawn(argv, {
    onStdout: (bytes) => {
      text += decoder.decode(bytes, { stream: true });
      if (text.includes('ready\n')) resolve();
    },
  });
  return { proc, ready, out: () => text };
}

export function within(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: timed out`)), ms)),
  ]);
}

export function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum * 31 + bytes[i]) >>> 0;
  return sum;
}
