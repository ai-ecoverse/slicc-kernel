const decoder = new TextDecoder();
const SHARED_PAGES = 4;
const STACK_PAGE = 65536;

async function compile(ctx, name) {
  return WebAssembly.compile(ctx.sync.fs.readFile(`/node_modules/jswasi/bin/${name}`));
}

function instance(wasi, module, memory) {
  const imports = { ...wasi.imports, ...(memory ? { env: { memory } } : {}) };
  const inst = new WebAssembly.Instance(module, imports);
  if (memory) wasi.bind(memory);
  else wasi.initialize(inst);
  return inst;
}

function readAll(ctx, fd) {
  let out = '';
  for (;;) {
    const chunk = ctx.sync.read(fd);
    if (chunk.length === 0) return out;
    out += decoder.decode(chunk);
  }
}

function fdCount(ctx) {
  return ctx.sync.fs.readdir('/dev/fd').length;
}

const threads = {
  async hold(ctx, port) {
    const { module, memory } = ctx.thread.data;
    const wasi = ctx.sync.wasi.create({ preopens: { '/sandbox': '/w' } });
    const inst = new WebAssembly.Instance(module, { ...wasi.imports, env: { memory } });
    wasi.bind(memory);
    inst.exports.__stack_pointer.value = (SHARED_PAGES + 3) * STACK_PAGE;
    inst.exports.run(4);
    port.postMessage(fdCount(ctx));
    await new Promise(() => {});
  },
  async exiting(ctx) {
    const { module, memory } = ctx.thread.data;
    const wasi = ctx.sync.wasi.create({ preopens: { '/sandbox': '/w' } });
    const inst = new WebAssembly.Instance(module, { ...wasi.imports, env: { memory } });
    wasi.bind(memory);
    inst.exports.__stack_pointer.value = (SHARED_PAGES + 3) * STACK_PAGE;
    inst.exports.run(4);
    ctx.sync.exit(6);
  },
  async leak(ctx, port) {
    const { module, memory, n } = ctx.thread.data;
    const wasi = ctx.sync.wasi.create({ preopens: { '/sandbox': '/w' } });
    const inst = new WebAssembly.Instance(module, { ...wasi.imports, env: { memory } });
    wasi.bind(memory);
    inst.exports.__stack_pointer.value = (SHARED_PAGES + n) * STACK_PAGE;
    inst.exports.run(100 + n);
    inst.exports.run(4);
    port.postMessage('done');
    return 0;
  },
};

const cases = {
  async io(ctx) {
    ctx.sync.fs.mkdir('/w', { recursive: true });
    ctx.sync.fs.writeFile('/w/in.txt', 'hello from the host\n');
    const [r, w] = ctx.sync.pipe();
    const wasi = ctx.sync.wasi.create({ preopens: { '/sandbox': '/w' }, stdio: [0, w, 2] });
    const inst = instance(wasi, await compile(ctx, 'jswasi.wasm'));
    inst.exports.run(1);
    inst.exports.run(6);
    wasi.close();
    ctx.sync.close(w);
    return { stdout: readAll(ctx, r), out: ctx.sync.fs.readFile('/w/sub/out.txt').length };
  },
  async start(ctx) {
    const module = await compile(ctx, 'jswasi.wasm');
    const [r, w] = ctx.sync.pipe();
    const wasi = ctx.sync.wasi.create({ args: ['prog', 'one'], env: { A: 'b' }, stdio: [0, w, 2] });
    const code = wasi.start(new WebAssembly.Instance(module, wasi.imports));
    const strict = ctx.sync.wasi.create({ returnOnExit: false, stdio: [0, w, 2] });
    const caught = (fn) => {
      try {
        fn();
      } catch (err) {
        return { name: err.constructor.name, code: err.code };
      }
    };
    const thrown = caught(() => strict.start(new WebAssembly.Instance(module, strict.imports)));
    const empty = new WebAssembly.Instance(
      new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
    );
    const refused = [
      caught(() => strict.start(empty)),
      caught(() => strict.bind({})),
      strict.initialize(empty),
    ];
    const badStdio = caught(() =>
      ctx.sync.wasi.create({ preopens: { '/a': '/' }, stdio: [0, 99, 2] })
    );
    const badPreopens = [
      caught(() => ctx.sync.wasi.create({ preopens: 'x' })),
      caught(() => ctx.sync.wasi.create({ preopens: { '/a': '' } })),
    ];
    wasi.close();
    strict.close();
    ctx.sync.close(w);
    return {
      code,
      thrown,
      refused,
      badStdio,
      badPreopens,
      fds: fdCount(ctx),
      stdout: readAll(ctx, r),
    };
  },
  async escape(ctx) {
    ctx.sync.fs.mkdir('/w', { recursive: true });
    ctx.sync.fs.writeFile('/w/in.txt', 'x');
    ctx.sync.fs.mkdir('/w/sub', { recursive: true });
    const [r, w] = ctx.sync.pipe();
    const wasi = ctx.sync.wasi.create({ preopens: { '/sandbox': '/w' }, stdio: [0, w, 2] });
    instance(wasi, await compile(ctx, 'jswasi.wasm')).exports.run(2);
    wasi.close();
    ctx.sync.close(w);
    return { stdout: readAll(ctx, r) };
  },
  async collide(ctx) {
    ctx.sync.fs.mkdir('/w', { recursive: true });
    const own = [];
    for (let i = 0; i < 4; i++) {
      const f = ctx.sync.open(`/w/own-${i}.txt`, {
        read: true,
        write: true,
        create: true,
        truncate: true,
      });
      f.write(0, new TextEncoder().encode(`own ${i}\n`));
      own.push(f);
    }
    const [r, w] = ctx.sync.pipe();
    const before = own.map((f) => f.fd);
    const wasi = ctx.sync.wasi.create({ preopens: { '/sandbox': '/w' }, stdio: [0, w, 2] });
    const open = fdCount(ctx);
    instance(wasi, await compile(ctx, 'jswasi.wasm')).exports.run(3);
    wasi.close();
    const closed = fdCount(ctx);
    ctx.sync.close(w);
    const kept = own.map((f) => decoder.decode(f.read(0, 100)));
    for (const f of own) f.close();
    return {
      before,
      open,
      closed,
      stdout: readAll(ctx, r),
      kept,
      guest: decoder.decode(ctx.sync.fs.readFile('/w/guest.txt')),
      guest2: decoder.decode(ctx.sync.fs.readFile('/w/guest2.txt')),
    };
  },
  async threads(ctx) {
    ctx.sync.fs.mkdir('/w', { recursive: true });
    ctx.sync.fs.writeFile('/w/in.txt', 'x');
    const module = await compile(ctx, 'jswasi-shared.wasm');
    const memory = new WebAssembly.Memory({ initial: SHARED_PAGES + 4, maximum: 16, shared: true });
    const before = fdCount(ctx);
    const codes = [];
    for (const n of [1, 2]) {
      const t = await ctx.thread.spawn({ data: { kind: 'leak', module, memory, n } });
      codes.push(await t.exited);
    }
    return {
      codes,
      before,
      after: fdCount(ctx),
      files: [1, 2].map((n) => decoder.decode(ctx.sync.fs.readFile(`/w/t-${n}.txt`))),
      shared: memory.buffer instanceof SharedArrayBuffer,
    };
  },
  async terminate(ctx) {
    ctx.sync.fs.mkdir('/w', { recursive: true });
    ctx.sync.fs.writeFile('/w/in.txt', 'x');
    const module = await compile(ctx, 'jswasi-shared.wasm');
    const memory = new WebAssembly.Memory({ initial: SHARED_PAGES + 4, maximum: 16, shared: true });
    const before = fdCount(ctx);
    const quitter = await ctx.thread.spawn({ data: { kind: 'exiting', module, memory } });
    const exitCode = await quitter.exited;
    const afterExit = fdCount(ctx);
    const t = await ctx.thread.spawn({ data: { kind: 'hold', module, memory } });
    const holding = await new Promise((resolve) => {
      t.port.onmessage = (e) => resolve(e.data);
    });
    await t.terminate();
    return { before, exitCode, afterExit, holding, code: await t.exited, after: fdCount(ctx) };
  },
  async fault(ctx) {
    ctx.sync.fs.mkdir('/w', { recursive: true });
    ctx.sync.fs.writeFile('/w/in.txt', 'x');
    const [r, w] = ctx.sync.pipe();
    const wasi = ctx.sync.wasi.create({ preopens: { '/sandbox': '/w' }, stdio: [0, w, 2] });
    const inst = instance(wasi, await compile(ctx, 'jswasi.wasm'));
    const before = fdCount(ctx);
    for (let i = 0; i < 20; i++) inst.exports.run(10);
    const after = fdCount(ctx);
    wasi.close();
    ctx.sync.close(w);
    return { before, after, stdout: readAll(ctx, r).split('\n')[0] };
  },
  async poll(ctx) {
    const [r, w] = ctx.sync.pipe();
    const [ir, iw] = ctx.sync.pipe();
    ctx.sync.write(iw, 'ready');
    const wasi = ctx.sync.wasi.create({ stdio: [ir, w, 2] });
    instance(wasi, await compile(ctx, 'jswasi.wasm')).exports.run(9);
    wasi.close();
    ctx.sync.close(w);
    return { stdout: readAll(ctx, r) };
  },
  async readonly(ctx) {
    const [r, w] = ctx.sync.pipe();
    const wasi = ctx.sync.wasi.create({ preopens: { '/ro': ctx.env.RO_DIR }, stdio: [0, w, 2] });
    instance(wasi, await compile(ctx, 'jswasi.wasm')).exports.run(8);
    wasi.close();
    ctx.sync.close(w);
    return { stdout: readAll(ctx, r) };
  },
};

export default async function main(ctx) {
  if (ctx.thread.tid !== 0) return threads[ctx.thread.data.kind](ctx, ctx.thread.port);
  const out = await cases[ctx.argv[1]](ctx);
  await ctx.write(1, JSON.stringify(out));
  return 0;
}
