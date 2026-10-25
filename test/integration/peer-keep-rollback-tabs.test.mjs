import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage } from './kernel.mjs';
import { peerTab, sh } from './rename-tabs.mjs';

const chrome = await launch();
after(() => chrome.close());

const HOLDER = (dir, tag) =>
  [
    'import os, time',
    `fd = os.open('${dir}/f', os.O_RDWR)`,
    `mark = os.open('${dir}.h${tag}', os.O_RDWR | os.O_CREAT)`,
    `open('${dir}.opened${tag}', 'w').close()`,
    `while not os.path.exists('${dir}.go${tag}'): time.sleep(0.02)`,
    'out = []',
    'try:',
    '    out.append(os.pread(fd, 16, 0).decode().strip())',
    '    os.ftruncate(fd, 0)',
    "    os.pwrite(fd, b'kept', 0)",
    '    os.fsync(fd)',
    '    out.append(os.pread(fd, 16, 0).decode().strip())',
    '    os.close(fd)',
    'except OSError as e:',
    "    out.append(f'errno {e.errno}')",
    "print(' '.join(out))",
  ].join('\n');

const RMTREE = {
  pkg: JSON.stringify({
    name: 'rmtree',
    slicc: { commands: { rmtree: { abi: 'js', module: 'main.mjs' } } },
  }),
  main: [
    'export default async function main(ctx) {',
    '  try {',
    '    await ctx.fs.rm(ctx.argv[1]);',
    "    await ctx.write(1, 'removed\\n');",
    '    return 0;',
    '  } catch (err) {',
    '    await ctx.write(1, `${err.code}\\n`);',
    '    return 1;',
    '  }',
    '}',
  ].join('\n'),
};

const text = (out) => (typeof out === 'string' ? out : new TextDecoder().decode(out));

const hidden = (tab) =>
  tab.evaluate(async () => {
    const top = await navigator.storage.getDirectory();
    const dir = await top.getDirectoryHandle('.slicc-unlinked').catch(() => undefined);
    if (!dir) return [];
    const out = [];
    try {
      for await (const name of dir.keys()) out.push(name);
    } catch (e) {
      if (e?.name === 'NotFoundError') return null;
      throw e;
    }
    return out;
  });

const leftOf = async (tab, aside) => {
  let left = null;
  for (let i = 0; i < 200; i++) {
    const now = await hidden(tab);
    left = now?.filter((name) => aside.includes(name) || name.startsWith('shared.'));
    if (left?.length === 0) return [];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return left ?? ['.slicc-unlinked kept vanishing mid-listing'];
};

const until = async (check) => {
  while (!(await check())) await new Promise((resolve) => setTimeout(resolve, 20));
};

for (const holders of [1, 2]) {
  for (const occupy of [false, true]) {
    test(`a recursive rm by another tab that fails partway, after it set aside a file ${holders === 1 ? 'one tab holds' : 'two tabs hold'} open, ${occupy ? 'leaves the file kept for its holders when its name was taken meanwhile' : 'puts the file back, where its holders go on using it'}, and leaves no hidden file behind (#1608 e)`, {
      timeout: 900_000,
    }, async (t) => {
      const name = `kr${holders}${occupy ? 'o' : ''}`;
      const dir = `/root/${name}`;
      const { page } = await booted(chrome, t);
      await installPackage(page, 'wasm-coreutils');
      await installPackage(page, 'wasix-python', { skip: /^lib\/libpython[^/]*\.a$/ });
      assert.equal(
        (
          await sh(
            page,
            `rm -rf ${dir} ${dir}.* && mkdir -p ${dir} && echo old > ${dir}/f && echo other > ${dir}/other && echo made`
          )
        ).stdout,
        'made\n'
      );
      await page.evaluate(
        async (p, m) => {
          await window.opfs.write('node_modules/rmtree/package.json', p);
          await window.opfs.write('node_modules/rmtree/main.mjs', m);
        },
        RMTREE.pkg,
        RMTREE.main
      );
      const tabs = [page];
      if (holders === 2) tabs.push(await peerTab(page));
      const remover = await peerTab(page, {
        worker: `/rename/faulty-rm-worker.js?unremovable=${name}&first=other&seen=${dir}.seen${occupy ? `&occupy=${dir}/f` : ''}`,
      });
      for (const [i, tab] of tabs.entries()) {
        await tab.evaluate(
          (s, n) => {
            window[`holder${n}`] = window.kernel.run(['python3', '-c', s], { cwd: '/' });
          },
          HOLDER(dir, i + 1),
          i + 1
        );
        await until(() =>
          page.evaluate((p) => window.opfs.exists(p), `${dir.slice(1)}.opened${i + 1}`)
        );
      }
      await until(async () => {
        const listed = (await sh(remover, 'cat /proc/sys/kernel/slicc_peer_held')).stdout;
        return tabs.every((_, i) => listed.includes(`${dir}.h${i + 1}\n`));
      });
      const rm = await remover.evaluate((d) => window.kernel.run(['rmtree', d], { cwd: '/' }), dir);
      const aside = JSON.parse(
        await page.evaluate((p) => window.opfs.read(p), `${dir.slice(1)}.seen`)
      );
      const after = await sh(remover, `ls ${dir}; cat ${dir}/f`);
      console.log(
        `failed rm -r, ${holders} holder(s)${occupy ? ', name taken' : ''}: ${JSON.stringify(text(rm.stdout))} aside ${JSON.stringify(aside)} then ${JSON.stringify(after.stdout)}`
      );
      assert.notEqual(rm.status, 0);
      assert.equal(text(rm.stdout), 'EBUSY\n');
      assert.ok(
        aside.some((n) => (holders === 1 ? /\.p[0-9a-f]+$/ : /^shared\./).test(n)),
        `nothing was set aside before the failure: ${JSON.stringify(aside)}`
      );
      assert.equal(after.stdout, occupy ? 'f\nNEW' : 'f\nold\n');
      const outs = [];
      for (const [i, tab] of tabs.entries()) {
        await page.evaluate((p) => window.opfs.write(p, ''), `${dir.slice(1)}.go${i + 1}`);
        outs.push(text((await tab.evaluate((n) => window[`holder${n}`], i + 1)).stdout));
      }
      console.log(`holders: ${JSON.stringify(outs)}`);
      assert.deepEqual(outs, holders === 1 ? ['old kept\n'] : ['old kept\n', 'kept kept\n']);
      assert.equal((await sh(remover, `cat ${dir}/f`)).stdout, occupy ? 'NEW' : 'kept');
      assert.deepEqual(await leftOf(page, aside), [], 'a set-aside file was left behind');
    });
  }
}
