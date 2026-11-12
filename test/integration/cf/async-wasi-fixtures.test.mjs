import assert from 'node:assert/strict';
import { test } from 'node:test';
import { both, installFixture, kernelPair, shown, skip } from './async-wasi-harness.mjs';

const cases = {
  handlertest: [['handlertest'], ['handlertest', 'nodefer']],
  nesttest: [['nesttest']],
  sigjmptest: ['term', 'longjmp', 'direct', 'directmask', 'raise', 'fork'].map((m) => [
    'sigjmptest',
    m,
  ]),
  longwait: [
    ['longwait', 'alarm'],
    ...['select', 'ppoll', 'nanosleep'].map((m) => ['longwait', m]),
  ],
  npolltest: [['npolltest']],
  epolltest: [
    'closed',
    'connect',
    'counter',
    'eintr',
    'errors',
    'et-add',
    'fairness',
    'level-edge',
    'oneshot',
    'rdhup',
    'timeout',
  ].map((m) => ['epolltest', m]),
  semtest: ['handoff', 'inherit', 'spawn', 'try', 'timed', 'eintr', 'errors', 'unlink'].map((m) => [
    'semtest',
    m,
  ]),
  killspin: [],
};

for (const [fixture, runs] of Object.entries(cases)) {
  if (runs.length === 0) continue;
  test(`the ${fixture} fixture gives the same status, stdout and stderr on the async host`, {
    skip,
  }, async (t) => {
    const pair = await kernelPair(t, (kernel) => installFixture(kernel, fixture));
    for (const argv of runs) {
      const cwd = fixture === 'sigjmptest' ? '/tmp' : '/';
      const { sync, async } = await both(pair, argv, { cwd });
      assert.deepEqual(shown(async), shown(sync), argv.join(' '));
    }
  });
}
