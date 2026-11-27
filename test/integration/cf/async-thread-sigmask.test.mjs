import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asyncProcessEntry } from '../../../dist/async-process.js';
import { createNodeKernel } from '../../../dist/node.js';
import { installFixture, shown, skip } from './async-wasi-harness.mjs';

const HOLD_MS = 10_000;

const timedSelect = (message) =>
  message?.type === 'async-syscall' &&
  message.req?.op === 'fd-select' &&
  typeof message.req.timeoutMs === 'number' &&
  message.req.timeoutMs > 0;

function behindTheKill(link, seen) {
  const { promise: killed, resolve } = Promise.withResolvers();
  const release = (why) => {
    if (seen.released !== undefined) return;
    seen.released = why;
    clearTimeout(bound);
    resolve();
  };
  const bound = setTimeout(() => release(`no kill from the main thread in ${HOLD_MS} ms`), HOLD_MS);
  return {
    post: (message, transfer) => link.post(message, transfer),
    onMessage: (handler) => link.onMessage(handler),
    onClose: (handler) => link.onClose(handler),
    close: () => link.close(),
    async call(message, transfer) {
      const thread = message?.type === 'async-thread';
      if (thread && seen.released === undefined && timedSelect(message.message)) {
        seen.held++;
        await killed;
      }
      const reply = await link.call(message, transfer);
      if (!thread && message?.req?.op === 'proc-kill') release('kill');
      return reply;
    },
  };
}

test("a WASIX thread's unblocked signal reaches the kernel when the thread unblocks it, so a kill that overtakes the thread's next syscall goes to that thread", {
  skip,
  timeout: 60_000,
}, async (t) => {
  const seen = { held: 0, released: undefined };
  const kernel = await createNodeKernel({
    blocking: 'async',
    asyncProcess: {
      inline: (link, deps) => asyncProcessEntry(behindTheKill(link, seen), deps),
    },
  });
  t.after(() => kernel.terminate());
  await installFixture(kernel, 'sigthread');
  const r = shown(await kernel.run(['sigthread', 'handler'], { cwd: '/' }));
  assert.equal(seen.released, 'kill');
  assert.ok(seen.held > 0, 'no timed syscall of the thread waited behind the kill');
  assert.deepEqual(r, {
    status: 0,
    stdout: "SIGUSR1 handled on the thread that doesn't block it\n",
    stderr: '',
  });
});
