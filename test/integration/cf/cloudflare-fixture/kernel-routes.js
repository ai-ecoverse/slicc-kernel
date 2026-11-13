import {
  attachKernel,
  compiledTlsEngine,
  createCloudflareKernel,
  fetchTransport,
} from '../../../../dist/cloudflare.js';
import createTlsEngine from '../../../../node_modules/@ai-ecoverse/wasm-tls-engine/dist/slicc-tls-engine.mjs';
import tlsWasm from '../../../../node_modules/@ai-ecoverse/wasm-tls-engine/dist/slicc-tls-engine.wasm';
import { pendingTimers } from './timers.js';

function leb(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

function taggedWasm(tag) {
  const name = new TextEncoder().encode('slicc-image');
  const payload = new TextEncoder().encode(tag);
  const body = [...leb(name.length), ...name, ...payload];
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0, ...leb(body.length), ...body]);
}

export const FAKES = 12;

async function install(kernel) {
  for (let i = 0; i < FAKES; i++) {
    const name = i === 0 ? 'fake' : `fake${i}`;
    await kernel.writeFile(
      `/node_modules/${name}/package.json`,
      JSON.stringify({ slicc: { abi: 'wasi', commands: { [name]: { wasm: 'fake.wasm' } } } })
    );
    await kernel.writeFile(`/node_modules/${name}/fake.wasm`, taggedWasm(name));
  }
}

const json = (value, status = 200) => Response.json(value, { status });

export class KernelRoutes {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.kernel = undefined;
    this.terminals = new Map();
    this.clockReads = [];
    this.fetched = [];
    this.next = 1;
  }

  network() {
    const answer = async (url, init) => {
      const body = init.body ? await new Response(init.body).text() : '';
      this.fetched.push(`${init.method} ${url}`);
      return new Response(`${init.method} ${url} ${init.headers.get('x-test')} ${body}\n`, {
        status: url.endsWith('/teapot') ? 418 : 200,
        headers: { 'x-served': 'fixture' },
      });
    };
    return {
      transport: fetchTransport({ fetch: answer, redirect: 'manual' }),
      tlsEngine: compiledTlsEngine(createTlsEngine, tlsWasm),
    };
  }

  async boot({ process, waitMs, persist, localForks, memory, max, network, clock = true }) {
    this.kernel?.terminate();
    const started = Date.now();
    const storage = this.ctx.storage;
    const self = () => this.env.PLUMBING.get(this.ctx.id);
    this.kernel = await createCloudflareKernel({
      loader: this.env.LOADER,
      ...(clock
        ? {
            clock: () =>
              self()
                .now()
                .then((now) => {
                  this.clockReads.push(now);
                  return now;
                }),
          }
        : {}),
      processHost: { process, ...(localForks === false ? { localForks: false } : {}) },
      isolates: {
        ...(waitMs ? { waitMs } : {}),
        ...(memory ? { memory } : {}),
        ...(max ? { max } : {}),
      },
      ...(persist
        ? { sql: storage.sql, sqlite: { transaction: (fn) => storage.transactionSync(fn) } }
        : {}),
      ...(network ? { network: this.network() } : {}),
    });
    await install(this.kernel);
    return { bootMs: Date.now() - started };
  }

  async terminal({ argv }) {
    const id = this.next++;
    const entry = { out: '', ended: undefined, stamps: [] };
    const decoder = new TextDecoder();
    entry.terminal = await this.kernel.openTerminal(argv, {
      cwd: '/',
      onData: (bytes) => {
        const text = decoder.decode(bytes, { stream: true });
        entry.out += text;
        const at = entry.stamps.length;
        entry.stamps.push([Date.now(), text, this.clockReads.length]);
        this.env.PLUMBING.get(this.ctx.id)
          .now()
          .then((now) => {
            entry.stamps[at][0] = now;
          });
      },
    });
    entry.terminal.ended.then(
      (ended) => {
        entry.ended = ended;
      },
      (err) => {
        entry.ended = { error: String(err?.message ?? err) };
      }
    );
    this.terminals.set(id, entry);
    return { id, pid: entry.terminal.pid };
  }

  stats() {
    const { isolates, processes, images } = this.kernel;
    return {
      active: isolates.active,
      peak: isolates.peak,
      loads: processes.loads,
      images: images.size,
      peakShards: processes.placement.peakShards,
    };
  }

  async handle(path, args) {
    const entry = this.terminals.get(args.id);
    switch (path) {
      case '/kernel/boot':
        return json(await this.boot(args));
      case '/kernel/run': {
        const started = Date.now();
        try {
          const result = await this.kernel.run(args.argv, {
            cwd: '/',
            ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
          });
          return json({ ...result, ms: Date.now() - started });
        } catch (err) {
          return json({ thrown: String(err?.message ?? err), code: err?.code ?? null });
        }
      }
      case '/kernel/runs': {
        const results = await Promise.all(
          args.argvs.map((argv) => this.kernel.run(argv, { cwd: '/' }))
        );
        return json({ results, ...this.stats() });
      }
      case '/kernel/terminal':
        return json(await this.terminal(args));
      case '/kernel/write':
        entry.terminal.write(args.data);
        return json({ ok: true });
      case '/kernel/signal':
        entry.terminal.signal(args.signal);
        return json({ ok: true });
      case '/kernel/output':
        return json({ out: entry.out, ended: entry.ended ?? null, stamps: entry.stamps });
      case '/kernel/connect': {
        const attached = await attachKernel(await this.kernel.connect({ user: args.user }));
        const result = await attached.run(args.argv, { cwd: '/' });
        const decoder = new TextDecoder();
        const decoded = (value) => (typeof value === 'string' ? value : decoder.decode(value));
        const mounts = await attached.mounts();
        attached.close?.();
        return json({
          status: result.status,
          stdout: decoded(result.stdout),
          mounts: mounts.map((entry) => entry.target),
        });
      }
      case '/kernel/file-write':
        await this.kernel.writeFile(args.path, args.data);
        return json({ ok: true });
      case '/kernel/file-read':
        try {
          return json({ data: new TextDecoder().decode(await this.kernel.readFile(args.path)) });
        } catch (err) {
          return json({ error: String(err?.code ?? err?.message ?? err) });
        }
      case '/kernel/forks': {
        const { forks } = this.kernel.processes;
        return json({
          held: forks.size,
          fetched: forks.fetched,
          taken: forks.taken,
          placement: this.kernel.processes.placement.describe(),
        });
      }
      case '/kernel/fetched':
        return json({ fetched: this.fetched.splice(0) });
      case '/kernel/instantiate': {
        const bytes = Uint8Array.from(args.bytes);
        const made = await WebAssembly.instantiate(bytes, {}).then(
          (result) => Object.keys(result).sort(),
          (err) => String(err?.message ?? err)
        );
        return json({ made, patched: WebAssembly.instantiate.name });
      }
      case '/kernel/clock-reads':
        return json({ reads: this.clockReads.splice(0) });
      case '/kernel/timers':
        return json({ pending: pendingTimers() });
      case '/kernel/stats':
        return json(this.stats());
      case '/kernel/terminate':
        this.kernel.terminate();
        return json(this.stats());
      default:
        return json({ error: 'unknown route' }, 404);
    }
  }
}
