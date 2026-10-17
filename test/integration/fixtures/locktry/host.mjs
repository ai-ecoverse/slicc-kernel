export function createImports(ctx) {
  return {
    locktry: {
      run() {
        const [, mode, path] = ctx.argv;
        const out = (text) => ctx.fs.writeFile(`${path}.${mode}`, new TextEncoder().encode(text));
        const fd = ctx.fds.open(path, { read: true, write: true, create: true });
        const got = ctx.fds.tryLock(fd, mode !== 'shared');
        if (mode !== 'hold' || got !== 0) return out(`${got}\n`);
        out('held\n');
        while (!ctx.fs.exists(`${path}.release`)) ctx.async.wait(25);
        ctx.fds.unlock(fd);
        ctx.fds.close(fd);
      },
    },
  };
}
