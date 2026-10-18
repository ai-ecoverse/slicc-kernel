import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, installPackage, ok } from './kernel.mjs';
import { alone, measured, peerTab, per, report, worker } from './second-tab.mjs';

const chrome = await launch();
after(() => chrome.close());

const DIRS = 12;
const PER_DIR = 40;
const FILES = DIRS * PER_DIR;
const TAR_ROUNDS = 3;
const TAR_ENTRIES = 61;

async function tarball() {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-second-tab-'));
  await mkdir(join(dir, 'package'));
  await writeFile(
    join(dir, 'package', 'package.json'),
    JSON.stringify({ name: 'many', version: '1.0.0' })
  );
  for (let d = 0; d < DIRS; d++) {
    await mkdir(join(dir, 'package', `d${d}`));
    for (let f = 0; f < PER_DIR; f++) {
      await writeFile(
        join(dir, 'package', `d${d}`, `f${f}.js`),
        `export const v = ${d * 1000 + f};\n`
      );
    }
  }
  execFileSync('tar', ['czf', join(dir, 'many.tgz'), '-C', dir, 'package'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const bytes = await readFile(join(dir, 'many.tgz'));
  await rm(dir, { recursive: true, force: true });
  return bytes;
}

const pnpm = (n) => [
  'bash',
  '-c',
  `rm -rf /home/p${n} /home/s${n} && mkdir -p /home/p${n} && cd /home/p${n} && echo '{}' > package.json && pnpm add file:/srv/many.tgz --store-dir /home/s${n} >/dev/null 2>/tmp/pnpm${n}.err; echo "rc=$?"; ls -d node_modules/many/d*/f*.js | wc -l`,
];

const tar = [
  'bash',
  '-c',
  `cd /tmp/pack; s=$(wc -c < src.tar); for i in $(seq ${TAR_ROUNDS}); do rm -rf out && mkdir out; { head -c $((s - 10240)) src.tar; sleep 0.2; tail -c 10240 src.tar; } | tar -xf - -C out || echo fail; done; [ "$(cat out/src/inner/l60)" = first ] && echo good`,
];

test('cost per created file of pnpm and tar with one tab and with an idle second tab on the same OPFS root (#1017)', {
  timeout: Number.POSITIVE_INFINITY,
}, async (t) => {
  const { page, bash } = await booted(chrome, t, { worker: worker('writer') });
  for (const name of ['wasm-coreutils', 'wasm-tar', 'wasm-tls-engine', 'wasi-pnpm']) {
    await installPackage(page, name);
  }
  const bytes = (await tarball()).toString('base64');
  await page.evaluate(
    (b) =>
      window.opfs.write(
        'srv/many.tgz',
        Uint8Array.from(atob(b), (c) => c.charCodeAt(0))
      ),
    bytes
  );
  assert.deepEqual(
    await bash(
      'mkdir -p /tmp/pack/src/inner && cd /tmp/pack/src/inner && echo first > ../a.txt && for i in $(seq 60); do ln -s ../a.txt l$i; done && cd /tmp/pack && tar -cf src.tar src && pnpm --version >/dev/null && echo ready',
      { cwd: '/' }
    ),
    ok('ready\n')
  );
  const runs = [];
  const phase = async (name, peer, n) => {
    const p = await measured(page, peer, `pnpm ${name}`, pnpm(n), '/');
    assert.deepEqual(p.result, ok(`rc=0\n${FILES}\n`), `pnpm ${name}`);
    report(`pnpm ${name}`, FILES, p);
    const tr = await measured(page, peer, `tar ${name}`, tar, '/');
    assert.deepEqual(tr.result, ok('good\n'), `tar ${name}`);
    report(`tar ${name}`, TAR_ROUNDS * TAR_ENTRIES, tr);
    runs.push({ name, pnpm: p, tar: tr });
  };
  await phase('one tab', undefined, 1);
  const other = await peerTab(page);
  await phase('two tabs', other, 2);
  await other.close();
  await alone(page);
  await phase('one tab again', undefined, 3);
  for (const r of runs) {
    for (const w of ['pnpm', 'tar']) {
      assert.ok(r[w].writer.opfs > 0, `${r.name} ${w}: the kernel counts its OPFS calls`);
      assert.ok(
        (r[w].writer.counts['idb readwrite'] ?? 0) > 0,
        `${r.name} ${w}: the counting worker sees IndexedDB`
      );
    }
  }
  const [one, two] = runs;
  console.log(
    `COST ratio two tabs / one tab: pnpm wall ${per(two.pnpm.wall, one.pnpm.wall)}, opfs ${per(two.pnpm.writer.opfs, one.pnpm.writer.opfs)}; tar wall ${per(two.tar.wall, one.tar.wall)}, opfs ${per(two.tar.writer.opfs, one.tar.writer.opfs)}`
  );
});
