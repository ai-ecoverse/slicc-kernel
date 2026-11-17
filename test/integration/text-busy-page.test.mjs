import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const BASH = '/node_modules/@ai-ecoverse/wasm-bash/bin';
const W = '/node_modules/xsh/bin/bash.wasm';

const SETUP = [
  'rm -rf /node_modules/xsh/bin /tmp/up /tmp/go && mkdir -p /node_modules/xsh/bin /tmp',
  `cp ${BASH}/bash /node_modules/xsh/bin/bash && cp ${BASH}/bash.wasm ${W} && cp ${BASH}/bash.wasm /tmp/orig.wasm`,
  `{ cat ${BASH}/bash.wasm; printf new; } > /tmp/new.wasm`,
].join(' && ');

test("on the OPFS root, a write into a running program's wasm fails with ETXTBSY for bash and an attached client, rm then write works, and so does a write once it ends", {
  timeout: 300_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t);
  await page.evaluate(async () => {
    const pkg = {
      name: 'xsh',
      slicc: { abi: 'emscripten', commands: { xsh: { glue: 'bin/bash', wasm: 'bin/bash.wasm' } } },
    };
    await window.opfs.write('node_modules/xsh/package.json', JSON.stringify(pkg));
  });
  assert.equal((await bash(SETUP, { cwd: '/' })).status, 0);
  const seen = await page.evaluate(async (w) => {
    const sh = (s) => window.kernel.run(['bash', '-c', s], { cwd: '/' });
    const start = async () => {
      await sh('rm -f /tmp/up /tmp/go');
      const ended = window.kernel.run(
        ['xsh', '-c', ': > /tmp/up; while [ ! -e /tmp/go ]; do sleep 0.05; done; echo ended'],
        { cwd: '/' }
      );
      let early;
      ended.then(
        (r) => {
          early = r;
        },
        (err) => {
          early = err;
        }
      );
      while ((await sh('test -e /tmp/up')).status !== 0) {
        if (early) throw new Error(`xsh ended before it was up: ${JSON.stringify(early)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return async () => {
        await sh(': > /tmp/go');
        return ended;
      };
    };
    const end = await start();
    const client = await window.attachKernel(await window.kernel.connect());
    const attached = await client.fs.writeFile(w, 'x').then(
      () => 'written',
      (err) => err.code
    );
    client.close();
    const busy = await sh(
      `cp /tmp/new.wasm ${w}; echo "cp rc=$?"; ln -sf ${w} /tmp/link && echo x > /tmp/link; echo "link rc=$?"`
    );
    const replaced = await sh(`rm ${w} && cp /tmp/orig.wasm ${w} && echo replaced`);
    const first = await end();
    const end2 = await start();
    const second = await sh(`truncate -s 0 ${w}; echo "rc=$?"`);
    const ended = await end2();
    const freed = await sh(`cp /tmp/new.wasm ${w} && echo written`);
    return { attached, busy, replaced, first, second, ended, freed };
  }, W);
  const done = { status: 0, stdout: 'ended\n', stderr: '' };
  assert.deepEqual(seen, {
    attached: 'ETXTBSY',
    busy: {
      status: 0,
      stdout: 'cp rc=1\nlink rc=1\n',
      stderr: `cp: cannot create regular file '${W}': Text file busy\nbash: line 1: /tmp/link: Text file busy\n`,
    },
    replaced: { status: 0, stdout: 'replaced\n', stderr: '' },
    first: done,
    second: {
      status: 0,
      stdout: 'rc=1\n',
      stderr: `truncate: cannot open '${W}' for writing: Text file busy\n`,
    },
    ended: done,
    freed: { status: 0, stdout: 'written\n', stderr: '' },
  });
});
