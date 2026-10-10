const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (bytes) => new TextDecoder().decode(bytes);

async function cat(ctx) {
  await ctx.stdin.pipeTo(ctx.stdout, { preventClose: true });
}

async function count(ctx) {
  let total = 0;
  for (;;) {
    const chunk = await ctx.read(0, 1 << 20);
    if (chunk.length === 0) break;
    total += chunk.length;
  }
  await ctx.write(1, `${total}\n`);
}

async function readycount(ctx) {
  await ctx.write(1, 'ready\n');
  await count(ctx);
}

async function yes(ctx) {
  const line = new TextEncoder().encode('y\n'.repeat(4096));
  for (;;) await ctx.write(1, line);
}

async function trap(ctx, [name = 'SIGINT', code = '130']) {
  let caught = 0;
  await ctx.signals.on(name, (sig) => {
    caught = sig;
  });
  await ctx.write(1, 'ready\n');
  while (!caught) await sleep(5);
  await ctx.write(1, `caught ${caught}\n`);
  return Number(code);
}

async function blocked(ctx) {
  await ctx.signals.on('SIGINT', () => ctx.exit(42));
  await ctx.write(1, 'ready\n');
  await ctx.read(0);
  return 0;
}

async function files(ctx, [path]) {
  const f = await ctx.open(path, { read: true, write: true, create: true, truncate: true });
  const big = new Uint8Array(3 * 1024 * 1024 + 17);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  await f.write(0, big);
  await f.write(big.length, new TextEncoder().encode('tail'));
  const size = await f.size();
  const back = await f.read(1024 * 1024 - 3, 2 * 1024 * 1024 + 9);
  let same = back.length === 2 * 1024 * 1024 + 9;
  for (let i = 0; same && i < back.length; i++) same = back[i] === (1024 * 1024 - 3 + i) % 251;
  const end = text(await f.read(size - 4, 100));
  await f.truncate(10);
  await f.sync();
  const cut = await f.size();
  await f.close();
  const st = await ctx.fs.stat(path);
  const again = await ctx.open(path);
  const head = await again.read(0, 3);
  await ctx.close(again.fd);
  await ctx.write(1, `${size} ${same} ${end} ${cut} ${st.size} ${st.isFile} ${head.join('.')}\n`);
}

async function fsops(ctx, [dir]) {
  await ctx.fs.mkdir(`${dir}/a/b`);
  await ctx.fs.writeFile(`${dir}/a/b/one.txt`, 'one');
  await ctx.fs.rename(`${dir}/a/b/one.txt`, `${dir}/a/two.txt`);
  await ctx.fs.symlink('two.txt', `${dir}/a/link`);
  const listed = (await ctx.fs.readdir(`${dir}/a`)).sort().join(',');
  const linked = await ctx.fs.readlink(`${dir}/a/link`);
  const content = text(await ctx.fs.readFile(`${dir}/a/two.txt`));
  const lst = await ctx.fs.lstat(`${dir}/a/link`);
  await ctx.fs.unlink(`${dir}/a/link`);
  const gone = await ctx.fs.exists(`${dir}/a/link`);
  const errors = [];
  for (const attempt of [
    () => ctx.open(`${dir}/missing`),
    () => ctx.open(`${dir}/a/two.txt`, { create: true, exclusive: true }),
    () => ctx.open(`${dir}/a`),
  ]) {
    errors.push(
      await attempt().then(
        () => 'ok',
        (err) => err.code
      )
    );
  }
  await ctx.fs.rm(`${dir}/a`);
  await ctx.write(
    1,
    `${listed} ${linked} ${content} ${lst.isSymbolicLink} ${gone} ${errors.join(',')} ${await ctx.fs.exists(dir + '/a')}\n`
  );
}

async function coherent(ctx, [path]) {
  const f = await ctx.open(path, { read: true, write: true, create: true, truncate: true });
  await f.write(0, new TextEncoder().encode('hello'));
  const a = text(await ctx.fs.readFile(path));
  await ctx.fs.writeFile(path, 'world!');
  const b = text(await f.read(0, 10));
  await ctx.fs.rename(path, `${path}.moved`);
  await f.write(0, new TextEncoder().encode('W'));
  const c = text(await ctx.fs.readFile(`${path}.moved`));
  await ctx.fs.unlink(`${path}.moved`);
  await f.write(6, new TextEncoder().encode('?'));
  const d = text(await f.read(0, 10));
  await f.close();
  await ctx.write(1, `${a} ${b} ${c} ${d} ${await ctx.fs.exists(`${path}.moved`)}\n`);
}

async function append(ctx, [path]) {
  const f = await ctx.open(path, { write: true, create: true, truncate: true });
  await f.write(0, new TextEncoder().encode('ab'));
  await f.close();
  const g = await ctx.open(path, { append: true });
  await g.write(0, new TextEncoder().encode('cd'));
  await g.write(0, new TextEncoder().encode('ef'));
  await g.close();
  await ctx.write(1, `${text(await ctx.fs.readFile(path))}\n`);
}

async function exclusive(ctx, [path]) {
  const tries = await Promise.allSettled([
    ctx.open(path, { write: true, create: true, exclusive: true }),
    ctx.open(path, { write: true, create: true, exclusive: true }),
  ]);
  const got = tries.filter((t) => t.status === 'fulfilled');
  for (const t of got) await t.value.close();
  const codes = tries.filter((t) => t.status === 'rejected').map((t) => t.reason.code);
  await ctx.write(1, `${got.length} ${codes.join(',')}\n`);
}

async function lock(ctx, [path]) {
  const r = await ctx.open(path, { write: true, create: true, exclusive: true }).then(
    async (f) => {
      await f.close();
      return 'got';
    },
    (err) => err.code
  );
  await ctx.write(1, `${r}\n`);
}

async function closed(ctx, [path]) {
  const f = await ctx.open(path, { write: true, create: true, truncate: true });
  await f.close();
  const g = await ctx.open(`${path}.other`, {
    read: true,
    write: true,
    create: true,
    truncate: true,
  });
  await g.write(0, new TextEncoder().encode('keep'));
  const code = (p) =>
    p.then(
      () => 'ok',
      (err) => err.code
    );
  const after = [
    await code(f.write(0, new TextEncoder().encode('XX'))),
    await code(f.read(0, 4)),
    await code(f.truncate(0)),
    await code(f.size()),
    await code(f.sync()),
    await code(f.close()),
  ];
  const kept = text(await g.read(0, 10));
  await g.close();
  await ctx.write(1, `${after.join(',')} ${kept}\n`);
}

async function badtrunc(ctx, [path]) {
  const f = await ctx.open(path, { read: true, write: true, create: true, truncate: true });
  await f.write(0, new TextEncoder().encode('abc'));
  const code = (p) =>
    p.then(
      () => 'ok',
      (err) => err.code
    );
  const tries = [
    await code(f.truncate(-1)),
    await code(f.truncate(1.5)),
    await code(f.truncate(Number.NaN)),
  ];
  const size = await f.size();
  await f.close();
  await ctx.write(1, `${tries.join(',')} ${size} ${text(await ctx.fs.readFile(path))}\n`);
}

async function dangling(ctx, [path]) {
  await ctx.fs.symlink(`${path}.target`, path);
  const r = await ctx.open(path, { write: true, create: true, exclusive: true }).then(
    async (f) => {
      await f.close();
      return 'opened';
    },
    (err) => err.code
  );
  await ctx.write(1, `${r} ${await ctx.fs.exists(`${path}.target`)}\n`);
}

async function unawaited(ctx) {
  ctx.write(1, new Uint8Array(4 * 1024 * 1024).fill(121));
  return 0;
}

async function pid(ctx) {
  await ctx.write(1, `${ctx.pid} ${await ctx.ppid()}\n`);
}

async function queued(ctx) {
  const w = ctx.stdout.getWriter();
  for (let i = 0; i < 3; i++) w.write(new Uint8Array(1024 * 1024).fill(97 + i));
  w.write(new TextEncoder().encode('END\n'));
  return 0;
}

async function resetpipe(ctx) {
  await ctx.signals.reset('SIGPIPE');
  await yes(ctx);
}

async function ticker(ctx, [count = '20', ms = '50']) {
  for (let i = 0; i < Number(count); i++) {
    await ctx.write(1, `tick ${i}\n`);
    await sleep(Number(ms));
  }
}

async function nap(ctx, [ms = '1000']) {
  await ctx.write(1, 'ready\n');
  const started = performance.now();
  await sleep(Number(ms));
  const slept = performance.now() - started;
  await ctx.write(2, `${slept >= Number(ms) + 400 ? 'held' : 'ran'}\n`);
  return 3;
}

async function badmax(ctx) {
  const code = (p) =>
    p.then(
      () => 'ok',
      (err) => err.code
    );
  const out = [];
  for (const max of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    out.push(await code(ctx.read(0, max)));
  await ctx.write(1, `${out.join(',')}\n`);
}

async function strayw(ctx) {
  ctx.write(99, 'x');
  return 0;
}

async function ctxclose(ctx, [path]) {
  const f = await ctx.open(path, { write: true, create: true, truncate: true });
  await ctx.close(f.fd);
  const g = await ctx.open(`${path}.other`, {
    read: true,
    write: true,
    create: true,
    truncate: true,
  });
  await g.write(0, new TextEncoder().encode('keep'));
  const r = await f.write(0, new TextEncoder().encode('XX')).then(
    () => 'ok',
    (err) => err.code
  );
  const kept = text(await g.read(0, 10));
  await g.close();
  await ctx.write(1, `${g.fd === f.fd} ${r} ${kept}\n`);
}

async function badpos(ctx, [path]) {
  const f = await ctx.open(path, { read: true, write: true, create: true, truncate: true });
  await f.write(0, new TextEncoder().encode('abc'));
  const code = (p) =>
    p.then(
      () => 'ok',
      (err) => err.code
    );
  const one = new TextEncoder().encode('Z');
  const tries = [
    await code(f.read(-1, 1)),
    await code(f.read(1.5, 1)),
    await code(f.read(0, -1)),
    await code(f.read(0, Number.POSITIVE_INFINITY)),
    await code(f.write(-1, one)),
    await code(f.write(0.5, one)),
  ];
  await f.close();
  await ctx.write(1, `${tries.join(',')} ${text(await ctx.fs.readFile(path))}\n`);
}

async function selfloop(ctx, [path]) {
  await ctx.fs.symlink(path.split('/').pop(), path);
  const r = await ctx.open(path, { write: true, create: true, exclusive: true }).then(
    () => 'opened',
    (err) => err.code
  );
  await ctx.write(1, `${r}\n`);
}

async function alias(ctx, [dir]) {
  const enc = (t) => new TextEncoder().encode(t);
  await ctx.fs.mkdir(`${dir}/real`);
  await ctx.fs.symlink('real', `${dir}/alias`);
  const a = await ctx.open(`${dir}/alias/f`, {
    read: true,
    write: true,
    create: true,
    truncate: true,
  });
  const r = await ctx.open(`${dir}/real/f`, { read: true, write: true });
  await a.write(0, enc('one'));
  const seen1 = text(await r.read(0, 10));
  await r.write(0, enc('TWO'));
  const seen2 = text(await a.read(0, 10));
  await ctx.fs.unlink(`${dir}/alias`);
  await r.write(3, enc('+'));
  await a.close();
  await r.close();
  const final = text(await ctx.fs.readFile(`${dir}/real/f`));
  await ctx.write(1, `${seen1} ${seen2} ${final}\n`);
}

async function aliasrm(ctx, [dir]) {
  await ctx.fs.mkdir(`${dir}/real`);
  await ctx.fs.writeFile(`${dir}/real/f`, 'keep');
  await ctx.fs.symlink('real', `${dir}/alias`);
  const h = await ctx.open(`${dir}/alias/f`, { read: true, write: true });
  await ctx.fs.unlink(`${dir}/real/f`);
  const before = text(await h.read(0, 10));
  await h.write(4, new TextEncoder().encode('!'));
  const after = text(await h.read(0, 10));
  const gone = !(await ctx.fs.exists(`${dir}/real/f`));
  await h.close();
  await ctx.write(1, `${before} ${after} ${gone}\n`);
}

async function opens(ctx, [path, n = '200']) {
  const started = performance.now();
  for (let i = 0; i < Number(n); i++) {
    const f = await ctx.open(path, { read: true });
    await f.read(0, 16);
    await f.close();
  }
  await ctx.write(1, `${Math.round(performance.now() - started)}\n`);
}

const drainText = async (stream) => {
  let out = '';
  for await (const chunk of stream) out += text(chunk);
  return out;
};

async function spawning(ctx, [dir]) {
  const lines = [];
  const echo = await ctx.spawn({ argv: ['jstest', 'echo', 'a', 'b c'], stdout: 'pipe' });
  lines.push(`${(await drainText(echo.stdout)).split('\n')[0]} ${(await echo.wait()).status}`);
  const counting = await ctx.spawn({ argv: ['jstest', 'count'], stdin: 'pipe', stdout: 'pipe' });
  const w = counting.stdin.getWriter();
  await w.write(new TextEncoder().encode('hello'));
  await w.close();
  lines.push(`${(await drainText(counting.stdout)).trim()} ${(await counting.wait()).status}`);
  const status = await ctx.spawn({ argv: ['jstest', 'status', '7'] });
  lines.push(`status ${(await ctx.wait(status.pid)).status}`);
  await ctx.fs.mkdir(dir);
  const where = await ctx.spawn({
    argv: ['jstest', 'echo'],
    cwd: ctx.resolve(dir),
    stdout: 'pipe',
  });
  lines.push(`cwd ${(await drainText(where.stdout)).split('\n')[1] === ctx.resolve(dir)}`);
  await where.wait();
  const silent = await ctx.spawn({ argv: ['jstest', 'echo', 'hidden'], stdout: 'null' });
  await silent.wait();
  const waiting = await ctx.spawn({ argv: ['jstest', 'wait'], stdout: 'pipe' });
  const reader = waiting.stdout.getReader();
  await reader.read();
  await ctx.kill(waiting.pid, 'SIGTERM');
  const killed = await waiting.wait();
  lines.push(`killed ${killed.status} ${killed.signal}`);
  const failing = await ctx.spawn({ argv: ['jstest', 'throw', 'oops'], stderr: 'pipe' });
  lines.push(`stderr ${(await drainText(failing.stderr)).trim()} ${(await failing.wait()).status}`);
  const stopped = await ctx.spawn({ argv: ['jstest', 'wait'], stdout: 'pipe' });
  await stopped.stdout.getReader().read();
  await stopped.kill();
  lines.push(`child.kill ${(await stopped.wait()).status}`);
  const yes = await ctx.spawn({ argv: ['jstest', 'yes'], stdout: 'pipe' });
  const yesReader = yes.stdout.getReader();
  await yesReader.read();
  await yesReader.cancel();
  lines.push(`cancel ${(await yes.wait()).status}`);
  const aborted = await ctx.spawn({ argv: ['jstest', 'count'], stdin: 'pipe', stdout: 'pipe' });
  await aborted.stdin.abort();
  lines.push(`abort ${(await drainText(aborted.stdout)).trim()} ${(await aborted.wait()).status}`);
  const toErr = await ctx.spawn({ argv: ['jstest', 'echo', 'to-stderr'], stdout: 2 });
  await toErr.wait();
  const missing = await ctx.spawn({ argv: ['no-such-command'] }).then(
    () => 'ok',
    (err) => err.code
  );
  const empty = await ctx.spawn({ argv: [] }).then(
    () => 'ok',
    (err) => err.code
  );
  lines.push(`errors ${missing} ${empty}`);
  await ctx.write(1, `${lines.join('\n')}\n`);
  const inherited = await ctx.spawn({ argv: ['jstest', 'status', '0'], stdout: 'inherit' });
  await inherited.wait();
  const told = await ctx.spawn({ argv: ['jstest', 'echo', 'inherited'] });
  await told.wait();
}

async function numfd(ctx) {
  const free = [];
  for (let fd = 3; free.length < 2; fd++) {
    if (
      await ctx.fdStatus(fd).then(
        () => false,
        () => true
      )
    )
      free.push(fd);
  }
  const r = await ctx.spawn({ argv: ['jstest', 'echo'], stdin: 'pipe', stdout: free[1] }).then(
    () => 'spawned',
    (err) => err.code
  );
  await ctx.write(1, `${r}\n`);
}

async function stdiochecks(ctx) {
  const code = (p) =>
    p.then(
      () => 'ok',
      (err) => err.code
    );
  const typo = await code(ctx.spawn({ argv: ['jstest', 'echo'], stdout: 'pip' }));
  const c = await ctx.spawn({ argv: ['jstest', 'wait'], stdout: 'null', stderr: 'null' });
  await c.kill(0);
  await c.kill('SIGKILL');
  await c.wait();
  const gone = await code(c.kill(0));
  await ctx.close(2);
  const closed = await code(ctx.spawn({ argv: ['jstest', 'echo'], stdin: 'pipe' }));
  await ctx.write(1, `${typo} ${gone} ${closed}\n`);
}

async function ab(ctx) {
  let go = false;
  await ctx.signals.on('SIGUSR1', () => {
    go = true;
  });
  await ctx.write(1, 'A');
  while (!go) await sleep(5);
  await ctx.write(1, 'B');
}

async function lowestFree(ctx) {
  for (let fd = 3; ; fd++) {
    if (
      await ctx.fdStatus(fd).then(
        () => false,
        () => true
      )
    )
      return fd;
  }
}

async function readsteal(ctx) {
  const readEnd = await lowestFree(ctx);
  const c = await ctx.spawn({ argv: ['jstest', 'ab'], stdout: 'pipe', stderr: 'null' });
  const out = c.stdout.getReader();
  const a = text((await out.read()).value);
  const pending = out.read();
  await sleep(50);
  const cat = await ctx.spawn({ argv: ['jstest', 'cat'], stdin: readEnd, stdout: 'pipe' });
  await out.cancel();
  await pending;
  await c.kill('SIGUSR1');
  await c.wait();
  let got = '';
  const r = cat.stdout.getReader();
  for (let x = await r.read(); !x.done; x = await r.read()) got += text(x.value);
  await cat.wait();
  await ctx.write(1, `${a} ${got}\n`);
}

async function readcancel(ctx) {
  const c = await ctx.spawn({ argv: ['jstest', 'wait'], stdout: 'pipe', stderr: 'null' });
  const out = c.stdout.getReader();
  await out.read();
  const pending = out.read();
  await sleep(50);
  await out.cancel();
  const after = await pending;
  await c.kill();
  const exited = await c.wait();
  await ctx.write(1, `cancelled ${after.done} ${exited.status}\n`);
}

async function waitcount(ctx) {
  let go = false;
  await ctx.signals.on('SIGUSR1', () => {
    go = true;
  });
  await ctx.write(1, 'ready\n');
  while (!go) await sleep(5);
  let total = 0;
  for (;;) {
    const chunk = await ctx.read(0, 1 << 20);
    if (chunk.length === 0) break;
    total += chunk.length;
  }
  await ctx.write(1, `${total}`);
}

async function spawnabort(ctx) {
  const c = await ctx.spawn({
    argv: ['jstest', 'waitcount'],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'null',
  });
  const out = c.stdout.getReader();
  await out.read();
  const w = c.stdin.getWriter();
  const big = 4 * 1024 * 1024;
  w.write(new Uint8Array(big)).catch(() => undefined);
  await sleep(50);
  await w.abort().catch(() => undefined);
  await c.kill('SIGUSR1');
  let got = '';
  for (let r = await out.read(); !r.done; r = await out.read()) got += text(r.value);
  await c.wait();
  const short = Number(got) < 1024 * 1024;
  const free = [];
  for (let fd = 3; free.length < 2; fd++) {
    if (
      await ctx.fdStatus(fd).then(
        () => false,
        () => true
      )
    )
      free.push(fd);
  }
  const badfd = await ctx.spawn({ argv: ['jstest', 'echo'], stdin: 'pipe', stdout: free[1] }).then(
    () => 'ok',
    (err) => err.code
  );
  await ctx.write(1, `aborted ${short} ${badfd}\n`);
  return 0;
}

async function nodir(ctx, [path]) {
  const r = await ctx.open(path, { write: true, create: true }).then(
    () => 'opened',
    (err) => err.code
  );
  await ctx.write(1, `${r}\n`);
}

async function fds(ctx) {
  const out = [];
  for (const fd of [0, 1, 2]) {
    const s = await ctx.fdStatus(fd);
    out.push(`${fd}:${s.type}:${s.tty}:${s.seekable}:${await ctx.isatty(fd)}`);
  }
  await ctx.write(2, `${out.join(' ')}\n`);
}

async function globals(ctx) {
  const names = [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'Worker',
    'indexedDB',
    'caches',
    'postMessage',
    'importScripts',
  ];
  const seen = names.map((n) => `${n}=${typeof globalThis[n]}`);
  seen.push(`storage=${typeof globalThis.navigator?.storage}`);
  seen.push(`locks=${typeof globalThis.navigator?.locks}`);
  for (const n of [
    'VideoEncoder',
    'VideoDecoder',
    'AudioEncoder',
    'ImageDecoder',
    'OffscreenCanvas',
  ]) {
    seen.push(`${n}=${typeof globalThis[n]}`);
  }
  await ctx.write(1, `${seen.join(' ')}\n`);
}

async function encode(ctx) {
  if (typeof VideoEncoder === 'undefined') {
    await ctx.write(2, 'no WebCodecs here\n');
    return 69;
  }
  const config = { codec: 'vp8', width: 64, height: 64, bitrate: 200_000, framerate: 30 };
  const { supported } = await VideoEncoder.isConfigSupported(config);
  const chunks = [];
  const encoder = new VideoEncoder({
    output: (chunk) => chunks.push(chunk),
    error: (err) => ctx.write(2, `${err.message}\n`),
  });
  encoder.configure(config);
  const canvas = new OffscreenCanvas(64, 64);
  const g = canvas.getContext('2d');
  for (let i = 0; i < 3; i++) {
    g.fillStyle = `rgb(${i * 80}, 40, 200)`;
    g.fillRect(0, 0, 64, 64);
    const frame = new VideoFrame(canvas, { timestamp: i * 33_333 });
    encoder.encode(frame, { keyFrame: i === 0 });
    frame.close();
  }
  await encoder.flush();
  encoder.close();
  const bytes = chunks.reduce((n, c) => n + c.byteLength, 0);
  await ctx.write(
    1,
    `supported=${supported} chunks=${chunks.length} first=${chunks[0]?.type} bytes>0=${bytes > 0}\n`
  );
}

async function full(ctx) {
  const r = await ctx.write(1, 'x').then(
    () => 'ok',
    (err) => err.code
  );
  await ctx.write(2, `${r}\n`);
}

async function devices(ctx) {
  const zero = await ctx.read(0, 8);
  await ctx.write(1, `${zero.length} ${zero.every((b) => b === 0)}\n`);
}

function synccat(ctx) {
  for (;;) {
    const chunk = ctx.sync.read(0, 1 << 20);
    if (chunk.length === 0) return 0;
    ctx.sync.write(1, chunk);
  }
}

async function syncyes(ctx, [how]) {
  const line = new TextEncoder().encode('y\n'.repeat(4096));
  if (how === 'ignore') await ctx.signals.ignore('SIGPIPE');
  try {
    for (;;) ctx.sync.write(1, line);
  } catch (err) {
    ctx.sync.write(2, `${err.code}\n`);
    return 7;
  }
}

async function synctrap(ctx) {
  let caught = 0;
  await ctx.signals.on('SIGUSR1', (sig) => {
    caught = sig;
  });
  await ctx.write(1, 'ready\n');
  let line = '';
  for (let chunk = ctx.sync.read(0); chunk.length > 0; chunk = ctx.sync.read(0))
    line += text(chunk);
  ctx.sync.write(1, `caught ${caught} ${line}`);
}

async function syncexit(ctx) {
  await ctx.signals.on('SIGINT', () => ctx.exit(42));
  await ctx.write(1, 'ready\n');
  ctx.sync.read(0);
  return 0;
}

async function syncthrow(ctx) {
  await ctx.signals.on('SIGINT', () => {
    throw new Error('handler boom');
  });
  await ctx.write(1, 'ready\n');
  ctx.sync.read(0);
  return 0;
}

function syncerr(fn) {
  try {
    fn();
    return 'ok';
  } catch (err) {
    return err.code;
  }
}

function syncfiles(ctx, [dir]) {
  const { sync } = ctx;
  sync.fs.mkdir(dir);
  const f = sync.open(`${dir}/big.bin`, { read: true, write: true, create: true });
  const big = new Uint8Array(2 * 1024 * 1024 + 5).map((_, i) => i % 251);
  const wrote = f.write(0, big);
  const back = f.read(1024 * 1024 - 1, 1024 * 1024 + 3);
  const same = back.every((b, i) => b === (1024 * 1024 - 1 + i) % 251);
  f.truncate(3);
  f.sync();
  const size = f.size();
  f.close();
  const errors = [
    syncerr(() => f.size()),
    syncerr(() => sync.open(`${dir}/none`)),
    syncerr(() => sync.open(`${dir}/big.bin`, { create: true, exclusive: true })),
    syncerr(() => sync.open(dir)),
    syncerr(() => sync.read(0, -1)),
    syncerr(() => sync.fs.stat(`${dir}/none`)),
    syncerr(() => sync.open(`${dir}/no/such`, { write: true, create: true })),
  ];
  const log = sync.open(`${dir}/log`, { write: true, append: true, create: true });
  log.write(0, new TextEncoder().encode('ab'));
  log.write(0, new TextEncoder().encode('cd'));
  sync.close(log.fd);
  errors.push(syncerr(() => log.sync()));
  sync.fs.writeFile(`${dir}/one`, 'one');
  sync.fs.rename(`${dir}/one`, `${dir}/two`);
  sync.fs.symlink('two', `${dir}/link`);
  const listed = sync.fs.readdir(dir).sort().join(',');
  const linked = `${sync.fs.readlink(`${dir}/link`)} ${text(sync.fs.readFile(`${dir}/link`))}`;
  const kinds = `${sync.fs.lstat(`${dir}/link`).isSymbolicLink} ${sync.fs.stat(`${dir}/log`).size}`;
  sync.fs.unlink(`${dir}/link`);
  const gone = sync.fs.exists(`${dir}/link`);
  sync.fs.rm(`${dir}/two`);
  const head = text(sync.open(`${dir}/log`).read(0, 10));
  sync.write(
    1,
    `${wrote} ${same} ${size} ${errors.join(',')} ${listed} ${linked} ${kinds} ${gone} ${head}\n`
  );
}

function syncdev(ctx) {
  const zero = ctx.sync.read(0, 8);
  ctx.sync.write(2, 'gone');
  ctx.sync.write(1, `${zero.length} ${zero.every((b) => b === 0)}\n`);
}

async function readAll(readable) {
  let out = '';
  for await (const chunk of readable) out += text(chunk);
  return out;
}

async function httpserver(ctx, [port = '0', count = '1']) {
  const listener = await ctx.net.listen({ port: Number(port) });
  await ctx.write(1, `listening ${listener.port > 0}\n`);
  let served = 0;
  for await (const c of listener) {
    const reader = c.readable.getReader();
    let head = '';
    while (!head.includes('\r\n\r\n')) {
      const next = await reader.read();
      if (next.done) break;
      head += text(next.value);
    }
    const path = head.split(' ')[1];
    const body = `hello from js ${path} ${c.remote.host}\n`;
    const w = c.writable.getWriter();
    await w.write(
      new TextEncoder().encode(
        `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
      )
    );
    await w.close();
    await c.close();
    if (++served >= Number(count)) await listener.close();
  }
  await ctx.write(1, `served ${served}\n`);
}

async function echoserver(ctx, [port]) {
  const listener = await ctx.net.listen({ port: Number(port) });
  await ctx.write(1, 'ready\n');
  const c = await listener.accept();
  await c.readable.pipeTo(c.writable);
  await c.close();
  await listener.close();
}

async function netclient(ctx, [port, message = 'ping']) {
  const c = await ctx.net.connect({ host: 'localhost', port: Number(port) });
  const w = c.writable.getWriter();
  await w.write(new TextEncoder().encode(message));
  await w.close();
  const answer = await readAll(c.readable);
  await c.close();
  await ctx.write(1, `${answer} ${c.local.host} ${c.remote.port === Number(port)}\n`);
}

async function netmisc(ctx) {
  const out = [];
  const code = (p) =>
    p.then(
      () => 'ok',
      (err) => (err.name === 'AbortError' ? 'AbortError' : err.code)
    );
  const l = await ctx.net.listen();
  out.push(`ephemeral ${l.port >= 32768} ${l.host}`);
  out.push(`inuse ${await code(ctx.net.listen({ port: l.port }))}`);
  out.push(`badport ${await code(ctx.net.listen({ port: 70000 }))}`);
  out.push(`v6 ${await code(ctx.net.listen({ host: '::1' }))}`);
  const c = new AbortController();
  setTimeout(() => c.abort(), 50);
  out.push(`abort ${await code(l.accept({ signal: c.signal }))}`);
  const client = await ctx.net.connect({ host: '127.0.0.1', port: l.port });
  const server = await l.accept();
  out.push(`next ${server.remote.port === client.local.port}`);
  await server.close();
  const w = client.writable.getWriter();
  let broken = 'ok';
  for (let i = 0; i < 64 && broken === 'ok'; i++) {
    broken = await w.write(new Uint8Array(64 * 1024)).then(
      () => 'ok',
      (err) => err.code
    );
  }
  out.push(`reset ${broken}`);
  await client.close();
  const other = await ctx.net.connect({ host: '127.0.0.1', port: l.port });
  const peer = await l.accept();
  await other.readable.cancel();
  await other.writable.abort();
  out.push(`cancelled ${(await readAll(peer.readable)) === ''}`);
  await peer.close();
  const closing = (async () => {
    const seen = [];
    for await (const conn of l) seen.push(conn);
    return seen.length;
  })();
  await sleep(20);
  await l.close();
  out.push(`iterclosed ${await closing}`);
  out.push(`refused ${await code(ctx.net.connect({ host: '127.0.0.1', port: l.port }))}`);
  const pre = new AbortController();
  pre.abort();
  out.push(
    `preabort ${await code(ctx.net.connect({ host: '127.0.0.1', port: 9, signal: pre.signal }))}`
  );
  out.push(`noname ${await code(ctx.net.connect({ host: 'no.such.name.invalid', port: 80 }))}`);
  const local = await ctx.net.listen();
  const plain = await ctx.net.connect({ port: local.port });
  out.push(`defaulthost ${plain.remote.host}:${plain.remote.port === local.port}`);
  await plain.close();
  out.push(`v6 ${await code(ctx.net.connect({ host: '::1', port: local.port }))}`);
  await local.close();
  await ctx.write(1, `${out.join('\n')}\n`);
}

function wsErr(err) {
  if (err.name === 'AbortError') return 'AbortError';
  return `${err.name}:${err.cause?.code ?? err.code ?? err.message}`;
}

async function wsTry(out, label, fn) {
  try {
    out.push(`${label} ${await fn()}`);
  } catch (err) {
    out.push(`${label} ${wsErr(err)}`);
  }
}

async function wsclient(ctx, [base]) {
  const out = [];
  const enc = new TextEncoder();
  await wsTry(out, 'echo', async () => {
    const ws = await ctx.websocket(`${base}/echo`, { protocols: ['chat', 'other'] });
    const w = ws.writable.getWriter();
    const r = ws.readable.getReader();
    await w.write('hi');
    await w.write(enc.encode('\x01\x02'));
    const a = (await r.read()).value;
    const b = (await r.read()).value;
    ws.close({ code: 4000, reason: 'done' });
    const end = await r.read();
    const closed = await ws.closed;
    return `${ws.protocol} ${a} ${[...b].join(',')} ${end.done} ${closed.code} ${closed.reason} ${ws.url}`;
  });
  await wsTry(out, 'serverclose', async () => {
    const ws = await ctx.websocket(base.replace(/^ws/, 'http') + '/echo');
    const w = ws.writable.getWriter();
    await w.write('bye');
    let n = 0;
    for await (const _ of ws.readable) n++;
    const closed = await ws.closed;
    return `${n} ${closed.code} ${closed.reason} ${ws.protocol === ''}`;
  });
  await wsTry(out, 'writerclose', async () => {
    const ws = await ctx.websocket(`${base}/echo`);
    await ws.writable.getWriter().close();
    return `${(await ws.closed).code}`;
  });
  await wsTry(out, 'cancel', async () => {
    const ws = await ctx.websocket(`${base}/echo`);
    await ws.readable.cancel();
    return `${(await ws.closed).code}`;
  });
  await wsTry(out, 'reset', async () => {
    const ws = await ctx.websocket(`${base}/reset`);
    const read = await ws.readable
      .getReader()
      .read()
      .then(() => 'read', wsErr);
    return `${read} ${await ws.closed.then(() => 'closed', wsErr)}`;
  });
  await wsTry(out, 'sendfail', async () => {
    const ws = await ctx.websocket(`${base}/echo`);
    return ws.writable
      .getWriter()
      .write('boom')
      .then(() => 'sent', wsErr);
  });
  await wsTry(out, 'backpressure', async () => {
    const ws = await ctx.websocket(`${base}/slow`);
    await ws.writable.getWriter().write('x');
    return 'sent';
  });
  await wsTry(out, 'sendafterclose', async () => {
    const ws = await ctx.websocket(`${base}/echo`);
    const w = ws.writable.getWriter();
    await w.write('bye');
    await ws.closed;
    return w.write('late').then(() => 'sent', wsErr);
  });
  await wsTry(out, 'abortbackpressure', async () => {
    const c = new AbortController();
    const ws = await ctx.websocket(`${base}/full`, { signal: c.signal });
    const writing = ws.writable
      .getWriter()
      .write('x')
      .then(() => 'sent', wsErr);
    await sleep(30);
    c.abort();
    return writing;
  });
  await wsTry(out, 'localclose', async () => {
    const ws = await ctx.websocket(`${base}/echo`);
    const w = ws.writable.getWriter();
    ws.close();
    return w.write('late').then(() => 'sent', wsErr);
  });
  await wsTry(out, 'closewhilefull', async () => {
    const ws = await ctx.websocket(`${base}/fullbye`);
    return ws.writable
      .getWriter()
      .write('x')
      .then(() => 'sent', wsErr);
  });
  await wsTry(out, 'abortwriter', async () => {
    const ws = await ctx.websocket(`${base}/full`);
    const w = ws.writable.getWriter();
    const writing = w.write('x').then(() => 'sent', wsErr);
    await sleep(30);
    const aborting = w.abort(new Error('stop writing'));
    return `${await writing} ${await aborting.then(() => 'aborted', wsErr)} ${(await ws.closed).code}`;
  });
  await wsTry(out, 'writerabort', async () => {
    const ws = await ctx.websocket(`${base}/echo`);
    await ws.writable.abort();
    return `${(await ws.closed).code}`;
  });
  await wsTry(out, 'refused', () => ctx.websocket(`${base}/refuse`));
  await wsTry(out, 'badproto', () => ctx.websocket(`${base}/badproto`, { protocols: 'chat' }));
  await wsTry(out, 'abortopen', () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 50);
    return ctx.websocket(`${base}/hang`, { signal: c.signal });
  });
  await wsTry(out, 'preabort', () =>
    ctx.websocket(`${base}/echo`, { signal: AbortSignal.abort() })
  );
  await wsTry(out, 'abortlater', async () => {
    const c = new AbortController();
    const ws = await ctx.websocket(`${base}/echo`, { signal: c.signal });
    const reading = ws.readable
      .getReader()
      .read()
      .then(() => 'read', wsErr);
    c.abort();
    const closed = await ws.closed.then(() => 'closed', wsErr);
    const sent = await ws.writable
      .getWriter()
      .write('x')
      .then(() => 'sent', wsErr);
    return `${await reading} ${closed} ${sent}`;
  });
  await wsTry(out, 'badurl', () => ctx.websocket('ftp://x/y'));
  await wsTry(out, 'longreason', async () => {
    const ws = await ctx.websocket(`${base}/echo`);
    try {
      ws.close({ reason: 'é'.repeat(62) });
    } finally {
      ws.close({ reason: 'é'.repeat(61) });
    }
  });
  await wsTry(out, 'badcode', async () => {
    const ws = await ctx.websocket(`${base}/echo`);
    try {
      ws.close({ code: 1001 });
    } finally {
      ws.close();
    }
  });
  await ctx.write(1, `${out.join('\n')}\n`);
}

async function wsone(ctx, [url]) {
  const out = [];
  await wsTry(out, 'one', async () => (await ctx.websocket(url)).protocol);
  await ctx.write(1, `${out.join('\n')}\n`);
}

function fetchErr(err) {
  return `${err.name}:${err.cause?.code ?? err.message}`;
}

async function fetchTry(out, label, fn) {
  try {
    out.push(`${label} ${await fn()}`);
  } catch (err) {
    out.push(`${label} ${fetchErr(err)}`);
  }
}

async function fetches(ctx, [base]) {
  const out = [];
  const f = (path, init) => ctx.fetch(`${base}${path}`, init);
  const post = {
    method: 'POST',
    body: 'abc',
    headers: { authorization: 'a', 'content-type': 't' },
  };
  await fetchTry(out, 'get', async () => {
    const r = await f('/hello');
    return `${r.status} ${r.headers.get('x-test')} ${await r.text()} ${r.url === `${base}/hello`} ${r.redirected}`;
  });
  await fetchTry(out, 'post', async () => (await f('/echo', post)).text());
  await fetchTry(out, 'stream', async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('st'));
        c.enqueue(new TextEncoder().encode('ream'));
        c.close();
      },
    });
    return (await f('/echo', { method: 'PUT', body, duplex: 'half' })).text();
  });
  await fetchTry(out, '303', async () => {
    const r = await f('/to/303/echo', post);
    return `${r.redirected} ${r.url === `${base}/echo`} ${await r.text()}`;
  });
  await fetchTry(out, '302', async () => (await f('/to/302/echo', post)).text());
  await fetchTry(out, '307', async () => (await f('/to/307/echo', post)).text());
  await fetchTry(out, 'xorigin', async () =>
    (
      await f('/away', {
        ...post,
        headers: { ...post.headers, cookie: 'c=1', 'proxy-authorization': 'p' },
      })
    ).text()
  );
  await fetchTry(out, 'fragment', async () => {
    const r = await f('/where#secret');
    return `${await r.text()} ${r.url}`;
  });
  await fetchTry(out, 'manual', async () => {
    const r = await f('/to/302/echo', { redirect: 'manual' });
    return `${r.status} ${r.headers.get('location')}`;
  });
  await fetchTry(out, 'error', () => f('/to/302/echo', { redirect: 'error' }));
  await fetchTry(out, 'loop', () => f('/loop'));
  await fetchTry(out, 'ftp', () => f('/ftp'));
  await fetchTry(out, 'teapot', async () => {
    const r = await f('/teapot');
    return `${r.status} ${await r.text()}`;
  });
  await fetchTry(out, 'down', () => f('/down'));
  await fetchTry(out, 'big', async () => {
    const r = await f('/echo', { method: 'POST', body: 'x'.repeat(2000) });
    return `${r.status} ${await r.text()}`;
  });
  await fetchTry(out, 'head', async () => {
    const r = await f('/hello', { method: 'HEAD' });
    return `${r.status} ${r.body === null}`;
  });
  await fetchTry(out, 'nocontent', async () => `${(await f('/204')).body === null}`);
  await fetchTry(out, 'info', () => f('/101'));
  await fetchTry(out, 'abort', () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 50);
    return f('/hang', { signal: c.signal });
  });
  await fetchTry(out, 'preaborted', () => f('/hello', { signal: AbortSignal.abort() }));
  await fetchTry(out, 'abortbody', async () => {
    const c = new AbortController();
    const reader = (await f('/forever', { signal: c.signal })).body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    c.abort();
    return `${first} ${await reader.read().then(() => 'read', fetchErr)}`;
  });
  await fetchTry(out, 'cancel', async () => {
    const reader = (await f('/forever')).body.getReader();
    await reader.read();
    await reader.cancel();
    return 'cancelled';
  });
  await fetchTry(out, 'slowbody', () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 50);
    const body = new ReadableStream({ pull: () => new Promise(() => {}) });
    return f('/echo', { method: 'POST', body, duplex: 'half', signal: c.signal });
  });
  await fetchTry(out, 'idleabort', async () => {
    const c = new AbortController();
    const r = await f('/idle', { signal: c.signal });
    c.abort();
    const read = await r.text().then(() => 'read', fetchErr);
    await sleep(20);
    return `${read} ${await (await f('/idlecount')).text()}`;
  });
  await fetchTry(out, 'followed', async () => {
    const r = await f('/followed');
    return `${r.redirected} ${r.url}`;
  });
  await fetchTry(out, 'gzip', async () => (await f('/gzip')).text());
  await fetchTry(out, 'brokenbody', async () => (await f('/broken')).text());
  await ctx.write(1, `${out.join('\n')}\n`);
}

async function fetchone(ctx, [url, redirect = 'follow']) {
  const out = [];
  await fetchTry(out, 'one', async () => {
    const r = await ctx.fetch(url, { redirect });
    return `${r.status} ${(await r.text()).length > 0}`;
  });
  await ctx.write(1, `${out.join('\n')}\n`);
}

const modes = {
  httpserver,
  echoserver,
  netclient,
  netmisc,
  wsclient,
  wsone,
  fetches,
  fetchone,
  stdiochecks,
  ab,
  readsteal,
  readcancel,
  waitcount,
  echo: async (ctx, args) => {
    await ctx.write(
      1,
      `${ctx.argv.join('|')}\n${ctx.cwd}\n${ctx.env.JSTEST_PACKAGE ?? ''}\n${ctx.pid > 0}\n${ctx.resolve('../x/./y')}\n${args.length}\n`
    );
  },
  cat,
  count,
  readycount,
  yes,
  trap,
  blocked,
  files,
  fsops,
  fds,
  coherent,
  append,
  exclusive,
  lock,
  nodir,
  spawning,
  spawnabort,
  numfd,
  alias,
  aliasrm,
  opens,
  selfloop,
  unawaited,
  pid,
  ticker,
  nap,
  badmax,
  queued,
  resetpipe,
  strayw,
  ctxclose,
  badpos,
  closed,
  badtrunc,
  dangling,
  synccat,
  syncyes,
  synctrap,
  syncfiles,
  syncdev,
  syncexit,
  syncthrow,
  globals,
  devices,
  full,
  encode,
  status: async (_ctx, [n]) => Number(n),
  exit: (ctx, [n]) => ctx.exit(Number(n)),
  throw: (_ctx, [m]) => {
    throw new Error(m);
  },
  wait: async (ctx) => {
    await ctx.write(1, 'ready\n');
    await new Promise(() => {});
  },
  stray: async () => {
    setTimeout(() => {
      throw new Error('late');
    }, 1);
    await new Promise(() => {});
  },
  ignore: async (ctx) => {
    await ctx.signals.ignore('SIGPIPE');
    try {
      await yes(ctx);
    } catch (err) {
      await ctx.write(2, `${err.code}\n`);
      return 7;
    }
  },
  badsig: async (ctx) => {
    const out = [];
    for (const s of ['SIGBOGUS', 0, 'SIGKILL']) {
      out.push(
        await ctx.signals
          .on(s, () => {})
          .then(
            () => 'ok',
            (err) => err.code
          )
      );
    }
    await ctx.signals.on(10, () => {});
    await ctx.signals.reset('SIGUSR1');
    await ctx.write(1, `${out.join(',')}\n`);
  },
};

export default async function main(ctx) {
  const [, mode, ...args] = ctx.argv;
  const run = modes[mode];
  if (!run) {
    await ctx.write(2, `usage: jstest <${Object.keys(modes).join('|')}>\n`);
    return 2;
  }
  return run(ctx, args);
}
