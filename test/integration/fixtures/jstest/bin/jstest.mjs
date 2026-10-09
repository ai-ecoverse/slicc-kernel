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

async function devices(ctx) {
  const zero = await ctx.read(0, 8);
  await ctx.write(1, `${zero.length} ${zero.every((b) => b === 0)}\n`);
}

const modes = {
  echo: async (ctx, args) => {
    await ctx.write(
      1,
      `${ctx.argv.join('|')}\n${ctx.cwd}\n${ctx.env.JSTEST_PACKAGE ?? ''}\n${ctx.pid > 0}\n${ctx.resolve('../x/./y')}\n${args.length}\n`
    );
  },
  cat,
  count,
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
  globals,
  devices,
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
