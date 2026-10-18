export function createImports(ctx) {
  return {
    umask_host: {
      restrict() {
        ctx.syscall({ op: 'proc-umask', mask: 0o077 });
      },
    },
  };
}
