import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

test('on the OPFS root, bash keeps starting and its files keep existing while a writer outside the kernel overwrites its package in place with createWritable, package.json last (#1075)', {
  timeout: 900_000,
}, async (t) => {
  const { page, bash } = await booted(chrome, t);
  assert.equal((await bash('echo exec-ok', { cwd: '/' })).stdout, 'exec-ok\n');
  const out = await page.evaluate(async (rounds) => {
    const root = await navigator.storage.getDirectory();
    const dirOf = async (parts) => {
      let d = root;
      for (const p of parts) d = await d.getDirectoryHandle(p);
      return d;
    };
    const pkg = ['node_modules', '@ai-ecoverse', 'wasm-bash'];
    const files = [];
    const walk = async (d, prefix) => {
      for await (const [name, h] of d.entries()) {
        if (h.kind === 'directory') await walk(h, [...prefix, name]);
        else files.push([...prefix, name]);
      }
    };
    await walk(await dirOf(pkg), []);
    files.sort((a, b) => (a.at(-1) === 'package.json') - (b.at(-1) === 'package.json'));
    let stop = false;
    let rewrites = 0;
    const rewriter = (async () => {
      for (let r = 0; r < rounds; r++) {
        for (const f of files) {
          const d = await dirOf([...pkg, ...f.slice(0, -1)]);
          const h = await d.getFileHandle(f.at(-1));
          const bytes = await (await h.getFile()).arrayBuffer();
          const w = await h.createWritable();
          await w.write(bytes);
          await w.close();
          rewrites++;
        }
      }
      stop = true;
    })();
    const dir = '/node_modules/@ai-ecoverse/wasm-bash';
    const looks = window.kernel.run(
      [
        'bash',
        '-c',
        `n=0; bad=0; while [ ! -e /tmp/done ]; do for f in ${files.map((f) => `${dir}/${f.join('/')}`).join(' ')}; do [ -e $f ] || bad=$((bad+1)); n=$((n+1)); done; done; echo $bad $n`,
      ],
      { cwd: '/' }
    );
    const fails = [];
    let runs = 0;
    while (!stop) {
      runs++;
      try {
        const r = await window.kernel.run(['bash', '-c', 'echo exec-ok'], { cwd: '/' });
        if (r.stdout !== 'exec-ok\n') fails.push(JSON.stringify(r).slice(0, 300));
      } catch (e) {
        fails.push('threw ' + String(e).slice(0, 200) + ' at rewrite ' + rewrites);
      }
    }
    await rewriter.catch((e) => fails.push('rewriter ' + String(e)));
    await window.kernel.run(['bash', '-c', ': > /tmp/done'], { cwd: '/' });
    const [bad, looked] = (await looks).stdout.trim().split(' ').map(Number);
    return {
      runs,
      rewrites,
      files: files.length,
      fails: fails.slice(0, 5),
      failed: fails.length,
      bad,
      looked,
    };
  }, 30);
  assert.ok(out.runs > 0 && out.looked > 0 && out.rewrites === 30 * out.files, JSON.stringify(out));
  assert.equal(out.bad, 0, JSON.stringify(out));
  assert.deepEqual(out.fails, []);
});
