const dec = new TextDecoder();

export default async function main(ctx) {
  const { sync } = ctx;
  sync.fs.mkdir('/tmp/p/q/r', { recursive: true });
  sync.fs.symlink('/dev/null', '/tmp/p/null');
  sync.fs.symlink('/dev', '/tmp/p/dev');
  const calls = () => Number(dec.decode(sync.fs.readFile('/proc/sys/kernel/slicc_fs_calls')));
  const span = (op) => {
    const before = calls();
    op();
    return calls() - before;
  };
  const idle = span(() => {});
  const probe = (op) => span(op) - idle;
  const missing = '/tmp/p/q/r/missing';
  const enoent = (fn) => {
    try {
      fn();
      return 'found';
    } catch (err) {
      return err.code;
    }
  };
  const out = {
    link: [
      sync.fs.stat('/tmp/p/null').isCharacterDevice?.() ?? sync.fs.stat('/tmp/p/null').isFile,
      sync.fs.exists('/tmp/p/null'),
      dec.decode(sync.fs.readFile('/tmp/p/null')).length,
    ],
    dir: [
      sync.fs.stat('/tmp/p/dev/null').isFile,
      sync.fs.exists('/tmp/p/dev/null'),
      dec.decode(sync.fs.readFile('/tmp/p/dev/null')).length,
    ],
    async: [
      (await ctx.fs.stat('/tmp/p/dev/null')).isFile,
      await ctx.fs.exists('/tmp/p/null'),
      (await ctx.fs.readFile('/tmp/p/dev/null')).length,
    ],
    errors: [
      enoent(() => sync.fs.stat(missing)),
      enoent(() => sync.fs.readFile(missing)),
      sync.fs.exists(missing),
    ],
    calls: [
      probe(() => enoent(() => sync.fs.stat(missing))),
      probe(() => enoent(() => sync.fs.lstat(missing))),
      probe(() => enoent(() => sync.fs.readFile(missing))),
      probe(() => sync.fs.exists(missing)),
    ],
  };
  await ctx.write(1, new TextEncoder().encode(`${JSON.stringify(out)}\n`));
}
