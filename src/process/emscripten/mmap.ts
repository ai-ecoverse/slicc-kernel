import type { EmContext } from './context.ts';
import { EM, EmError, negated } from './errno.ts';

const PROT_WRITE = 2;
const MAP_PRIVATE = 2;
const MAP_TYPE = 0xf;
const MAP_ALIGN = 65536;
const MAX_READ = 1024 * 1024;

function readAt(ctx: EmContext, fd: number, target: Uint8Array, position: number): number {
  const e = ctx.host.fds.get(fd);
  let done = 0;
  while (done < target.length) {
    const want = Math.min(MAX_READ, target.length - done);
    let got: Uint8Array;
    if (e.type === 'file') got = e.file.pread(want, position + done);
    else got = ctx.sys.pread?.(fd, want, position + done) ?? new Uint8Array(0);
    if (got.length === 0) break;
    target.set(got, done);
    done += got.length;
  }
  return done;
}

export function mmapImport(ctx: EmContext): WebAssembly.ModuleImports {
  return {
    _mmap_js: negated(
      (
        len: number,
        prot: number,
        flags: number,
        fd: number,
        offset: bigint,
        allocated: number,
        addr: number
      ) => {
        const position = Number(offset);
        if (!Number.isSafeInteger(position)) return -EM.OVERFLOW;
        const e = ctx.host.fds.get(fd);
        const kernelFile = e.type === 'kernel' && ctx.host.fds.kind(fd, e) === 'file';
        if (e.type !== 'file' && !kernelFile) throw new EmError(43);
        const shared = (flags & MAP_TYPE) !== MAP_PRIVATE && (prot & PROT_WRITE) !== 0;
        if (shared) throw new EmError(43);
        if (e.type === 'file' && !e.file.readable) throw new EmError(2);
        if (len <= 0) return -EM.INVAL;
        const memalign = ctx.exports().emscripten_builtin_memalign;
        if (!memalign) return -EM.NOMEM;
        const data = new Uint8Array(len);
        const done = readAt(ctx, fd, data, position);
        const size = Math.ceil(len / MAP_ALIGN) * MAP_ALIGN;
        const ptr = memalign(MAP_ALIGN, size);
        if (!ptr) return -EM.NOMEM;
        const target = ctx.mem.bytes(ptr, size);
        target.fill(0);
        target.set(data.subarray(0, done));
        const v = ctx.mem.view();
        v.setInt32(allocated, 1, true);
        v.setUint32(addr, ptr, true);
        return 0;
      }
    ),
  };
}
