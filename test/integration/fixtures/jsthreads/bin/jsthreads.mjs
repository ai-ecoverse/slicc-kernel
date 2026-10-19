const said = (port) =>
  new Promise((resolve) => {
    port.onmessage = (e) => resolve(e.data);
  });
const PUT = [
  0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 2, 127, 127, 0, 2, 16, 1, 3, 101, 110, 118, 6, 109, 101,
  109, 111, 114, 121, 2, 3, 1, 1, 3, 2, 1, 0, 7, 7, 1, 3, 112, 117, 116, 0, 0, 10, 11, 1, 9, 0, 32,
  0, 32, 1, 54, 2, 0, 11,
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const threads = {
  async echo(ctx, port) {
    port.postMessage({ hello: ctx.thread.tid, pid: ctx.pid, data: ctx.thread.data.n });
    port.onmessage = (e) => port.postMessage(e.data * 2);
    await new Promise(() => {});
  },
  async sab(ctx, port) {
    const a = new Int32Array(ctx.thread.data.sab);
    Atomics.store(a, 0, 1);
    Atomics.notify(a, 0);
    Atomics.wait(a, 1, 0, 20000);
    port.postMessage(Atomics.load(a, 1));
    await new Promise(() => {});
  },
  async took(ctx, port) {
    port.postMessage(ctx.thread.data.ab.byteLength);
    await new Promise(() => {});
  },
  async exit(ctx) {
    await pause(10);
    ctx.exit(3);
  },
  async syncexit(ctx) {
    ctx.sync.exit(4);
  },
  async forever() {
    await new Promise(() => {});
  },
  async tick(ctx) {
    let n = 0;
    setInterval(() => n++, 10);
    for (;;) {
      await ctx.fs.writeFile('/tmp/ticks', String(n));
      await pause(20);
    }
  },
  async oom() {
    globalThis.kept = [];
    for (const e of [34, 50]) globalThis.kept.push(new ArrayBuffer(2 ** e));
  },
  async oomlike() {
    throw new RangeError('Array buffer allocation failed');
  },
  async throws() {
    throw new Error('boom in a thread');
  },
  async opens(ctx, port) {
    const file = await ctx.open('/tmp/shared.txt', { read: true });
    port.postMessage({ fd: file.fd, pid: ctx.pid });
    await new Promise(() => {});
  },
  async pipewake(ctx, port) {
    const got = await ctx.read(ctx.thread.data.fd);
    port.postMessage(new TextDecoder().decode(got));
    await new Promise(() => {});
  },
  async abandon(ctx) {
    void ctx.read(ctx.thread.data.fd).catch(() => {});
    await pause(50);
    return 0;
  },
  async sigreset(ctx) {
    await ctx.signals.reset('SIGUSR1');
    await ctx.signals.on('SIGUSR2', () => {});
    return 0;
  },
  async wasm(ctx, port) {
    const { module, memory } = await said(port);
    const instance = await WebAssembly.instantiate(module, { env: { memory } });
    instance.exports.put(0, 99);
    Atomics.notify(new Int32Array(memory.buffer), 0);
    const inner = await ctx.thread.spawn({ data: { kind: 'wasmInner', module, memory } });
    port.postMessage({ inner: await inner.exited });
    await new Promise(() => {});
  },
  async wasmInner(ctx) {
    const { module, memory } = ctx.thread.data;
    const instance = await WebAssembly.instantiate(module, { env: { memory } });
    instance.exports.put(4, 77);
    ctx.exit(5);
  },
  async nested(ctx, port) {
    const inner = await ctx.thread.spawn({ data: { kind: 'exit' } });
    port.postMessage({ inner: inner.tid, code: await inner.exited });
    await new Promise(() => {});
  },
};
const cases = {
  async messages(ctx) {
    const t = await ctx.thread.spawn({ data: { kind: 'echo', n: 5 } });
    const hello = await said(t.port);
    t.port.postMessage(21);
    const doubled = await said(t.port);
    await t.terminate();
    return {
      main: [ctx.thread.tid, ctx.thread.port === undefined],
      tid: t.tid,
      hello,
      doubled,
      pid: ctx.pid,
      ppid: (await ctx.ppid()) >= 1,
    };
  },
  async sab(ctx) {
    const sab = new SharedArrayBuffer(8);
    const a = new Int32Array(sab);
    const t = await ctx.thread.spawn({ data: { kind: 'sab', sab } });
    const woke = Atomics.wait(a, 0, 0, 20000);
    const seen = Atomics.load(a, 0);
    const back = said(t.port);
    Atomics.store(a, 1, 7);
    Atomics.notify(a, 1);
    const got = await back;
    await t.terminate();
    return { woke: woke !== 'timed-out', seen, got };
  },
  async transfer(ctx) {
    const ab = new ArrayBuffer(8);
    const t = await ctx.thread.spawn({ data: { kind: 'took', ab }, transfer: [ab] });
    const there = await said(t.port);
    await t.terminate();
    return { here: ab.byteLength, there };
  },
  async exits(ctx) {
    const a = await ctx.thread.spawn({ data: { kind: 'exit' } });
    const b = await ctx.thread.spawn({ data: { kind: 'syncexit' } });
    const codes = [await a.exited, await b.exited];
    await ctx.write(1, '');
    return { codes, alive: true };
  },
  async terminate(ctx) {
    const t = await ctx.thread.spawn({ data: { kind: 'forever' } });
    await t.terminate();
    return { code: await t.exited };
  },
  async tick(ctx) {
    await ctx.thread.spawn({ data: { kind: 'tick' } });
    for (let i = 0; i < 200; i++) {
      if (await ctx.fs.exists('/tmp/ticks')) break;
      await pause(10);
    }
    return { started: await ctx.fs.exists('/tmp/ticks') };
  },
  async cap(ctx) {
    const kept = [
      await ctx.thread.spawn({ data: { kind: 'forever' } }),
      await ctx.thread.spawn({ data: { kind: 'forever' } }),
    ];
    const third = await ctx.thread.spawn({ data: { kind: 'forever' } }).then(
      () => 'spawned',
      (e) => e.code
    );
    await kept[0].terminate();
    const again = await ctx.thread.spawn({ data: { kind: 'exit' } });
    return { third, after: await again.exited };
  },
  async oom(ctx) {
    const t = await ctx.thread.spawn({
      data: { kind: ctx.argv[2] === 'like' ? 'oomlike' : 'oom' },
    });
    const throws = await ctx.thread.spawn({ data: { kind: 'throws' } });
    return { oom: await t.exited, NO_MEMORY: ctx.thread.NO_MEMORY, throws: await throws.exited };
  },
  async fds(ctx) {
    await ctx.fs.writeFile('/tmp/shared.txt', 'from the thread fd');
    const t = await ctx.thread.spawn({ data: { kind: 'opens' } });
    const { fd, pid } = await said(t.port);
    const text = new TextDecoder().decode(await ctx.read(fd));
    await t.terminate();
    return { same: pid === ctx.pid, text };
  },
  async stop(ctx) {
    await ctx.thread.spawn({ data: { kind: 'tick' } });
    while (!(await ctx.fs.exists('/tmp/ticks'))) await pause(10);
    const child = await ctx.spawn({
      argv: ['jsthreads', 'stopper', String(ctx.pid)],
      stdout: 'pipe',
    });
    const [text] = await Promise.all([new Response(child.stdout).text(), child.wait()]);
    return JSON.parse(text);
  },
  async stopper(ctx) {
    const pid = Number(ctx.argv[2]);
    const ticks = async () => new TextDecoder().decode(await ctx.fs.readFile('/tmp/ticks'));
    await ctx.kill(pid, 'SIGSTOP');
    await pause(150);
    const a = await ticks();
    await pause(400);
    const b = await ticks();
    await ctx.kill(pid, 'SIGCONT');
    await pause(100);
    const c = await ticks();
    return { frozen: a === b, resumed: c !== b, timersFrozen: Number(c) - Number(b) < 35 };
  },
  async stub(ctx) {
    globalThis.MessageChannel = class {
      constructor() {
        this.port1 = {};
        this.port2 = {};
      }
    };
    const t = await ctx.thread.spawn({ data: { kind: 'exit' } });
    return { code: await t.exited };
  },
  async pipewake(ctx) {
    const [r, w] = await ctx.pipe();
    const t = await ctx.thread.spawn({ data: { kind: 'pipewake', fd: r } });
    const back = said(t.port);
    await pause(200);
    await ctx.write(w, 'late data');
    const got = await back;
    await t.terminate();
    return { got };
  },
  async abandon(ctx) {
    const [r, w] = await ctx.pipe();
    const t = await ctx.thread.spawn({ data: { kind: 'abandon', fd: r } });
    const code = await t.exited;
    await ctx.write(w, 'for main');
    const got = await Promise.race([
      ctx.read(r).then((b) => new TextDecoder().decode(b)),
      pause(3000).then(() => 'nothing'),
    ]);
    return { code, got };
  },
  async sigreset(ctx) {
    let caught = 0;
    await ctx.signals.on('SIGUSR1', () => {
      caught++;
    });
    const t = await ctx.thread.spawn({ data: { kind: 'sigreset' } });
    const code = await t.exited;
    await ctx.kill(ctx.pid, 'SIGUSR1');
    for (let i = 0; i < 100 && caught === 0; i++) await pause(10);
    return { code, caught };
  },
  async wasm(ctx) {
    const module = await WebAssembly.compile(new Uint8Array(PUT));
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const view = new Int32Array(memory.buffer);
    const t = await ctx.thread.spawn({ data: { kind: 'wasm' } });
    const back = said(t.port);
    t.port.postMessage({ module, memory });
    const woke = Atomics.wait(view, 0, 0, 20000);
    const { inner } = await back;
    await t.terminate();
    return { woke: woke !== 'timed-out', first: view[0], second: view[1], inner };
  },
  async nested(ctx) {
    const t = await ctx.thread.spawn({ data: { kind: 'nested' } });
    const got = await said(t.port);
    await t.terminate();
    return { outer: t.tid, ...got };
  },
};
export default async function main(ctx) {
  if (ctx.thread.tid !== 0) return threads[ctx.thread.data.kind](ctx, ctx.thread.port);
  const out = await cases[ctx.argv[1]](ctx);
  await ctx.write(1, JSON.stringify(out));
  return 0;
}
