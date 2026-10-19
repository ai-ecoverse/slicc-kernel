export function createImports(ctx) {
  const text = (ptr, len) =>
    new TextDecoder().decode(new Uint8Array(ctx.memory().buffer, ptr, len).slice());
  return {
    copy_host: {
      copy(src, srcLen, dst, dstLen, mode, excl) {
        if (typeof ctx.fs.copyFile !== 'function') return 52;
        try {
          ctx.fs.copyFile(text(src, srcLen), text(dst, dstLen), { mode, excl: excl !== 0 });
          return 0;
        } catch (err) {
          return ctx.errno(err);
        }
      },
    },
  };
}
