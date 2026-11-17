import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { client, REPO, startDev, until } from './cloudflare-fixture/dev.mjs';
import { uploadTree } from './cloudflare-fixture/upload.mjs';
import { printfOf } from './message-wasm.mjs';

const config = fileURLToPath(new URL('./cloudflare-fixture/wrangler.json', import.meta.url));
const MODULES = join(REPO, 'node_modules/@ai-ecoverse');
const BASH = '/node_modules/@ai-ecoverse/wasm-bash/bin';
const programs = (path) => path === 'package.json' || path === 'bin' || path.startsWith('bin/');
const RUN = crypto.randomUUID().slice(0, 8);
let dev;
let processHost;
let call;

function section(name) {
  const bytes = new TextEncoder().encode(name);
  return printfOf(new Uint8Array([0, bytes.length + 1, bytes.length, ...bytes]));
}

const run = (argv) => call('/kernel/run', { argv });
const sh = (script) => run(['bash', '-c', script]);

async function shell(name) {
  const dir = `/node_modules/${name}/bin`;
  const made = await sh(
    `mkdir -p ${dir} && cp ${BASH}/bash ${dir}/bash && { cat ${BASH}/bash.wasm; printf '${section(`${name}-${RUN}`)}'; } > ${dir}/bash.wasm`
  );
  assert.equal(made.status, 0, JSON.stringify(made));
  const manifest = {
    slicc: { abi: 'emscripten', commands: { [name]: { glue: 'bin/bash', wasm: 'bin/bash.wasm' } } },
  };
  await call('/kernel/file-write', {
    path: `/node_modules/${name}/package.json`,
    data: JSON.stringify(manifest),
  });
  return `${dir}/bash.wasm`;
}

before(async () => {
  processHost = (await import(join(REPO, 'dist/cloudflare-sources.js')).catch(() => ({})))
    .PROCESS_SOURCE;
  if (!processHost) return;
  dev = await startDev(config, {
    remote: { url: process.env.SLICC_CF_FIXTURE_URL, key: process.env.SLICC_CF_FIXTURE_KEY },
  });
  if (dev.skip) return;
  call = client(dev);
  assert.equal((await call('/kernel/boot', { memory: 1, persist: true })).status, 200);
  for (const name of ['wasm-bash', 'wasm-coreutils']) {
    await uploadTree(call, join(MODULES, name), `/node_modules/@ai-ecoverse/${name}`, programs);
  }
});

after(async () => {
  await dev?.stop?.();
});

const skipped = (t) => {
  const why = processHost ? dev.skip : 'dist/async-process.js is not built yet';
  if (why) t.skip(why);
  return Boolean(why);
};

const outcome = (r) => ({ status: r.status, stdout: r.stdout, stderr: r.stderr });

async function waiting(argv) {
  const { id } = await call('/kernel/terminal', { argv });
  const output = () => call('/kernel/output', { id });
  await until(async () => (await output()).out.includes('ready'));
  return {
    go: async () => {
      await call('/kernel/write', { id, data: 'go\n' });
      return until(async () => {
        const out = await output();
        return out.ended ? out : undefined;
      });
    },
  };
}

const WAIT_THEN_FORK = 'echo ready; read x; (echo child; true); echo "status $?"';

describe('a running program whose wasm is replaced keeps forking into new Dynamic Workers', {
  concurrency: false,
}, () => {
  test('after its wasm is removed, a fork that needs a cold Dynamic Worker still runs', async (t) => {
    if (skipped(t)) return;
    const wasm = await shell('rmsh');
    const shell1 = await waiting(['rmsh', '-c', WAIT_THEN_FORK]);
    assert.equal((await sh(`rm ${wasm}`)).status, 0);
    const out = await shell1.go();
    assert.match(out.out, /child\r?\nstatus 0\r?\n/, JSON.stringify(out));
    assert.equal(out.ended.status, 0);
    const gone = await run(['rmsh', '-c', 'echo again']);
    assert.equal(gone.code, 'ENOENT', JSON.stringify(gone));
  });

  test('after a new wasm is renamed over it, a fork still runs the old program and a fresh exec the new one', async (t) => {
    if (skipped(t)) return;
    const wasm = await shell('mvsh');
    const shell1 = await waiting(['mvsh', '-c', `${WAIT_THEN_FORK}; mvsh -c 'echo fresh'`]);
    const before = (await call('/kernel/stats')).images;
    const replaced = await sh(
      `{ cat ${wasm}; printf '${section(`new-${RUN}`)}'; } > /tmp/new.wasm && mv /tmp/new.wasm ${wasm}`
    );
    assert.equal(replaced.status, 0, JSON.stringify(replaced));
    const out = await shell1.go();
    assert.match(out.out, /child\r?\nstatus 0\r?\nfresh\r?\n/, JSON.stringify(out));
    assert.equal(out.ended.status, 0);
    const stats = await call('/kernel/stats');
    assert.equal(stats.held, 0);
    assert.equal(stats.images, before + 1, JSON.stringify({ before, stats }));
  });
});
