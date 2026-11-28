import { attachKernel, createKernel } from '/dist/index.js';
import { fixtureAdapter } from './lease-adapter.mjs';

const pkg = '/node_modules/@ai-ecoverse/slicc-cdp';
const file = `${pkg}/bin/playwright-cli.wasm`;
const sha256 = 'c3978b88a9190e50ad60ed93aeaf0c1db98d86b03e181f2a9207a7ac1ad99d96';
const options = { metadata: false, media: false, ca: false };

export async function observe() {
  const listing = [];
  async function visit(root, prefix) {
    for await (const [name, h] of root.entries()) {
      const path = `${prefix}/${name}`;
      listing.push(path);
      if (h.kind === 'directory') await visit(h, path);
    }
  }
  await visit(await navigator.storage.getDirectory(), '');
  const db = (await indexedDB.databases()).map((d) => [d.name, d.version]).sort();
  const locks = await navigator.locks.query();
  return {
    listing: listing.sort(),
    db,
    locks: [...locks.held, ...locks.pending].map((l) => l.name).sort(),
  };
}

async function boot() {
  const fixture = await fixtureAdapter();
  const tag = crypto.randomUUID();
  const kernel = await createKernel({ ...options, cdpLease: { tag, adapter: fixture.adapter } });
  return { kernel, tag, fixture };
}

async function released() {
  const res = await fetch(file);
  if (!res.ok) throw new Error('lease CLI missing');
  const wasm = new Uint8Array(await res.arrayBuffer());
  const sum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', wasm)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  if (sum !== sha256) throw new Error('release hash mismatch');
  return { wasm, sha256 };
}

async function code(work) {
  try {
    await work();
    return 'OK';
  } catch (e) {
    return e.code ?? e.message;
  }
}

async function install(job, input) {
  await job.kernel.installLeaseCli(input);
  const a = await job.kernel.attest(file);
  if (
    a.sha256 !== input.sha256 ||
    a.bytes.length !== input.wasm.length ||
    a.uid !== 0 ||
    (a.mode & 0o222) !== 0
  )
    throw new Error('attestation mismatch');
  return attachKernel(await job.kernel.connect({ tag: job.tag }), { locks: null });
}

export async function isolation() {
  const input = await released();
  const first = await boot();
  const second = await boot();
  const end = async (job) => {
    await job.kernel.terminate();
  };
  const baseline = await observe();
  const scratch = '/tmp/lease-memory-marker';
  const read = async (c) => new TextDecoder().decode(await c.fs.readFile(scratch));
  try {
    const a = await install(first, input),
      b = await install(second, input);
    await a.fs.writeFile(scratch, 'first job only');
    const missing = await code(() => b.fs.readFile(scratch));
    const listed = (await b.fs.readdir('/tmp')).includes('lease-memory-marker');
    await b.fs.writeFile(scratch, 'second job only');
    const files = [await read(a), await read(b)];
    const refusals = [];
    for (const path of [file, `${pkg}/package.json`])
      for (const work of [
        () => a.fs.writeFile(path, 'replaced'),
        () => a.fs.writeFile(path, ''),
        () => a.fs.rename(scratch, path),
        () => a.fs.rm(path),
      ])
        refusals.push(await code(work));
    const other = '/tmp/other.wasm';
    await a.fs.writeFile(other, input.wasm);
    const extra = await code(() => a.run([other], { cwd: '/' }));
    await a.fs.writeFile('/tmp/script', '#!/usr/bin/playwright-cli\n');
    const script = await code(() => a.run(['/tmp/script'], { cwd: '/' }));
    const quota = await code(() => a.fs.writeFile('/tmp/full', new Uint8Array(64 * 1024 * 1024)));
    const cli = (c, ...args) => c.run(['playwright-cli', ...args], { cwd: '/' });
    const req = await cli(
      a,
      'lease',
      'request',
      '--allow',
      'https://billing.example',
      '--for',
      '1h'
    );
    const snap = await cli(b, '--lease', second.fixture.lease, 'snapshot');
    const write = await cli(a, '--lease', first.fixture.lease, 'click', 'e1');
    const late = await code(() => first.kernel.installLeaseCli(input));
    const remaining = await read(b);
    const user = [first, second].flatMap((j) => j.fixture.seen.map((s) => s.stamp.uid));
    const snapshots = [baseline, await observe()];
    let began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    let aborted;
    const cancelled = new Promise((resolve) => {
      aborted = resolve;
    });
    first.fixture.adapter.action = async (_p, { signal }) => {
      began();
      await new Promise((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted();
            resolve();
          },
          { once: true }
        )
      );
      return { result: { text: 'late-must-not-release' } };
    };
    const active = cli(a, '--lease', first.fixture.lease, 'snapshot').catch(() => null);
    await started;
    await end(first);
    await cancelled;
    await a.closed;
    const ended = await active;
    if (JSON.stringify(ended).includes('late-must-not-release'))
      throw new Error('late lease output delivered');
    snapshots.push(await observe());
    const newJob = await boot();
    try {
      const c = await install(newJob, input);
      const fresh = await code(() => c.fs.readFile(scratch));
      return {
        missing,
        listed,
        files,
        refusals,
        extra,
        script,
        quota,
        req,
        snap,
        write,
        late,
        remaining,
        user,
        snapshots,
        fresh,
        jkt: first.fixture.jkt,
      };
    } finally {
      await end(newJob);
    }
  } finally {
    await end(first);
    await end(second);
  }
}

export async function bootFailures() {
  const input = await released();
  const job = await boot();
  const { kernel, tag } = job;
  try {
    const errors = [];
    for (const opts of [
      { root: await navigator.storage.getDirectory() },
      { worker: '/untrusted.js' },
      { extra: true },
      { cdpLease: { tag, adapter: job.fixture.adapter, root: 'memory' } },
    ])
      errors.push(
        await code(async () => {
          const k = await createKernel({
            ...options,
            cdpLease: { tag, adapter: job.fixture.adapter },
            ...opts,
          });
          await k.terminate();
        })
      );
    const early = await code(() => kernel.connect({ tag }));
    const oversize = await code(() =>
      kernel.installLeaseCli({ ...input, wasm: new Uint8Array(8 * 1024 * 1024 + 1) })
    );
    const bad = await code(() => kernel.installLeaseCli({ ...input, sha256: '0'.repeat(64) }));
    const sealed = await code(() => kernel.installLeaseCli(input));
    return { errors, early, oversize, bad, sealed };
  } finally {
    await kernel.terminate();
  }
}

export async function entries() {
  const input = await released();
  const job = await boot();
  try {
    const client = await install(job, input);
    let count = 0;
    let refusal;
    for (; count <= 4096; count++) {
      refusal = await code(() => client.fs.writeFile(`/tmp/entry-${count}`, ''));
      if (refusal !== 'OK') break;
    }
    return { count, refusal, existing: await client.fs.exists('/tmp/entry-0') };
  } finally {
    await job.kernel.terminate();
  }
}
