import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import {
  AHEAD,
  digest,
  FLOW,
  FLOW_CLOSE_SH,
  FLOW_SH,
  heldBack,
  READ,
  TOTAL,
} from './embedder-flow.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('a slow reader holds the page back through the relay, within two chunks, and gets the whole reply; an early close cancels it (media capture)', async (t) => {
  const { page, bash, run } = await booted(chrome, t, { requests: true, network: false });
  await page.evaluate(async (m) => {
    const pkg = {
      name: 'embflow',
      slicc: { commands: { embflow: { abi: 'js', module: 'flow.mjs' } } },
    };
    await window.opfs.write('node_modules/embflow/package.json', JSON.stringify(pkg));
    await window.opfs.write('node_modules/embflow/flow.mjs', m);
  }, FLOW);
  const last = () => page.evaluate(() => window.requests.flows.at(-1));
  const pick = ({ status, stdout, stderr }) => ({ status, stdout, stderr });
  assert.deepEqual(pick(await run(['embflow'], { cwd: '/tmp' })), {
    status: 0,
    stdout: `${TOTAL} 0\n`,
    stderr: '',
  });
  heldBack(await last(), 'page js');
  assert.deepEqual(pick(await bash(FLOW_SH, { cwd: '/tmp' })), {
    status: 0,
    stdout: `${digest(0, READ)}  -\n${digest(READ, TOTAL)}  -\n`,
    stderr: '',
  });
  heldBack(await last(), 'page sh');
  assert.deepEqual(pick(await run(['embflow', 'close'], { cwd: '/tmp' })), {
    status: 0,
    stdout: `${READ}\n`,
    stderr: '',
  });
  await page.until(() => window.requests.flows.at(-1).cancelled !== null);
  assert.equal((await last()).cancelled, 'closed');
  assert.ok((await last()).produced <= READ + AHEAD);
  assert.deepEqual(pick(await bash(FLOW_CLOSE_SH, { cwd: '/tmp' })), {
    status: 0,
    stdout: `${READ}\nclosed\n`,
    stderr: '',
  });
  await page.until(() => window.requests.flows.at(-1).cancelled !== null);
  assert.equal((await last()).cancelled, 'closed');
  assert.ok((await last()).produced <= READ + AHEAD);
  assert.equal(await page.evaluate(() => window.requests.flows.length), 4);
});
