import { createAsyncTransport } from '../../../dist/node.js';

const SAB_I_SIGNALS = 8;
const SAB_I_KILLED = 13;
const SAB_I_STOP = 15;
const SIGUSR1 = 10;
const usr1 = 1 << SIGUSR1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class Killed extends Error {}

function syscalls(t) {
  const killed = () => Atomics.load(t.header, SAB_I_KILLED) !== 0;
  const call = async (req, label = req.op) => {
    const result = await t.call(req, Number.POSITIVE_INFINITY, label);
    if (killed()) throw new Killed();
    return result;
  };
  const json = async (req) => {
    const r = await call(req);
    if (!r.ok) throw Object.assign(new Error(`${req.op}: ${r.errno}`), { code: r.errno });
    return r.kind === 'json' ? r.json : r.kind === 'bytes' ? r.bytes : undefined;
  };
  return {
    killed,
    call,
    json,
    write: (fd, text) =>
      json({ op: 'fd-write', fd, body: typeof text === 'string' ? encoder.encode(text) : text }),
    read: (fd, max = 65536) => json({ op: 'fd-read', fd, max }),
    sleep: (ms) => call({ op: 'fd-select', read: [], write: [], timeoutMs: ms }),
    catchUsr1: () => json({ op: 'sig-mask', caught: usr1, ignored: 0 }),
  };
}

function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum * 31 + bytes[i]) >>> 0;
  return sum;
}

const commands = {
  async id(sys, t, init) {
    const identity = await sys.json({ op: 'proc-identity' });
    await sys.write(
      1,
      `${JSON.stringify({ pid: init.pid, identity, args: init.args, image: init.program.image.slice(0, 7) })}\n`
    );
    return 0;
  },
  async out(sys) {
    await sys.write(1, 'to stdout\n');
    await sys.write(2, 'to stderr\n');
    return 7;
  },
  async cat(sys) {
    for (;;) {
      const bytes = await sys.read(0);
      if (!bytes || bytes.length === 0) return 0;
      await sys.write(1, bytes);
    }
  },
  async big(sys, _t, init) {
    const bytes = await sys.json({ op: 'read', path: init.args[1] });
    await sys.write(1, `${bytes.length} ${checksum(bytes)}\n`);
    return 0;
  },
  async bigwrite(sys, _t, init) {
    const size = Number(init.args[2]);
    const body = new Uint8Array(size);
    for (let i = 0; i < size; i++) body[i] = i % 251;
    await sys.json({ op: 'write', path: init.args[1], body });
    await sys.write(1, `${size} ${checksum(body)}\n`);
    return 0;
  },
  async sleep(sys, _t, init) {
    const ms = Number(init.args[1]);
    const start = performance.now();
    await sys.sleep(ms);
    await sys.write(1, `slept ${performance.now() - start >= ms - 2 ? 'enough' : 'short'}\n`);
    return 0;
  },
  async sigwait(sys, t) {
    await sys.catchUsr1();
    await sys.write(1, 'ready\n');
    const r = await sys.sleep(-1);
    const pending = Atomics.and(t.header, SAB_I_SIGNALS, ~usr1) & usr1;
    await sys.write(1, `${r.ok ? 'ok' : r.errno} ${pending ? 'USR1' : 'none'}\n`);
    return 0;
  },
  async sigspin(sys, t) {
    await sys.catchUsr1();
    await sys.write(1, 'ready\n');
    const woke = await t.wait(t.header, SAB_I_SIGNALS, 0, 10_000);
    const pending = Atomics.and(t.header, SAB_I_SIGNALS, ~usr1) & usr1;
    const r = await sys.sleep(20);
    const again = Atomics.load(t.header, SAB_I_SIGNALS) & usr1;
    await sys.write(
      1,
      `${woke} ${pending ? 'USR1' : 'none'} then ${r.ok ? 'slept' : r.errno} ${again ? 'again' : 'once'}\n`
    );
    return 0;
  },
  async twice(sys, t) {
    await sys.catchUsr1();
    await sys.write(1, 'ready\n');
    let seen = 0;
    while (seen < 2) {
      await t.wait(t.header, SAB_I_SIGNALS, 0, 10_000);
      if (Atomics.and(t.header, SAB_I_SIGNALS, ~usr1) & usr1) {
        seen++;
        await sys.write(1, `got ${seen}\n`);
      }
    }
    return 0;
  },
  async stopwatch(sys, t) {
    await sys.write(1, 'ready\n');
    const stopped = await t.wait(t.header, SAB_I_STOP, 0, 10_000);
    const continued = await t.wait(t.header, SAB_I_STOP, 1, 10_000);
    await sys.write(1, `stop ${stopped} continue ${continued}\n`);
    return 0;
  },
  async hang(sys) {
    await sys.write(1, 'ready\n');
    for (;;) await sys.sleep(-1);
  },
  async idle(sys, t) {
    await sys.write(1, 'ready\n');
    await t.wait(t.header, SAB_I_KILLED, 0);
    throw new Killed();
  },
  async fail(sys) {
    await sys.write(1, 'ready\n');
    throw new Error('deliberate failure');
  },
  async vanish(sys, t, init, link) {
    await sys.write(1, 'ready\n');
    if (init.args[1] === 'exit' && typeof process !== 'undefined' && !globalThis.inlineProcess) {
      process.exit(3);
    }
    link.close();
    return new Promise(() => {});
  },
  async pipe(sys, _t, init) {
    const [r, w] = await sys.json({ op: 'fd-pipe' });
    const child = await sys.json({
      op: 'proc-spawn',
      file: init.argv0,
      argv: [init.argv0, 'cat'],
      env: {},
      cwd: '/',
      stdio: [{ fd: r }, { fd: 1 }, { fd: 2 }],
    });
    await sys.json({ op: 'fd-close', fd: r });
    await sys.sleep(150);
    await sys.write(w, 'late\n');
    await sys.json({ op: 'fd-close', fd: w });
    const waited = await sys.json({ op: 'proc-wait', pid: child, nohang: false });
    await sys.write(1, `child ${typeof waited === 'object' ? JSON.stringify(waited) : waited}\n`);
    return 0;
  },
};

export function asyncProcessEntry(link) {
  const t = createAsyncTransport(link);
  t.init.then(
    async (init) => {
      const sys = syscalls(t);
      const name = init.args[0];
      const command = commands[name];
      t.post({ type: 'wasm-process-ready' });
      try {
        if (!command) throw new Error(`unknown command ${name}`);
        const code = await command(sys, t, init, link);
        t.post({ type: 'wasm-process-exit', code });
      } catch (err) {
        if (err instanceof Killed || sys.killed()) {
          t.post({ type: 'wasm-process-exit', code: Atomics.load(t.header, SAB_I_KILLED) });
          return;
        }
        t.post({ type: 'wasm-process-error', message: String(err?.message ?? err) });
      }
    },
    () => undefined
  );
}

export const decode = (bytes) => decoder.decode(bytes);
