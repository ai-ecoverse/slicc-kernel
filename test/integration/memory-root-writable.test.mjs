import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryRoot } from '../../dist/node.js';

test('an ordinary memoryRoot writable can close again and write after close', async () => {
  const root = memoryRoot();
  const file = await root.getFileHandle('ordinary', { create: true });
  const writer = await file.createWritable();
  await writer.write('one');
  await writer.close();
  await writer.close();
  await writer.write(' two');
  await writer.close();
  assert.equal(await (await file.getFile()).text(), 'one two');
});

test('a lease memory root refuses late writes and a second close on the same writable', async (t) => {
  const { leaseMemoryRoot } = await import('../../src/node/memory-root.ts');
  const memory = leaseMemoryRoot();
  t.after(() => memory.clear());
  const file = await memory.root.getFileHandle('leased', { create: true });
  const writer = await file.createWritable();
  await writer.write('one');
  await writer.close();
  await assert.rejects(writer.write(' two'), { name: 'NotFoundError' });
  await assert.rejects(writer.close(), { name: 'NotFoundError' });
  assert.equal(await (await file.getFile()).text(), 'one');
});
