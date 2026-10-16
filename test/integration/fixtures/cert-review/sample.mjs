import assert from 'node:assert/strict';
import { test } from 'node:test';

test('a passing test', () => {});

test('a failing test', () => {
  assert.equal(1, 2);
});

test('a skipped test', { skip: true }, () => {});

test('a parent', async (t) => {
  await t.test('a child that passes', () => {});
  await t.test('a child that fails', () => {
    throw new Error('child broke');
  });
});
