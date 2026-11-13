import { lookedOutside } from '../../realm/sync-sab-bridge.ts';
import {
  SAB_HEADER_I32,
  SAB_I_KILLED,
  SAB_I_SIGNALS,
  SAB_I_STOP,
  SAB_I_TIMERS,
} from '../../realm/sync-sab-wire.ts';
import { WasiExit, type WasiFunction } from '../wasi/wasi-host.ts';
import type { EmContext } from './context.ts';
import { EM, errnoOf, positive } from './errno.ts';
import { type FilesState, seekDir } from './files.ts';
import { sigpipeSpared } from './net.ts';

const EINTR = 27;
const KILLED_BY_SIGPIPE = 141;

const encoder = new TextEncoder();

export function holdStopped(ctx: EmContext): void {
  const header = new Int32Array(ctx.init.sab, 0, SAB_HEADER_I32);
  while (Atomics.load(header, SAB_I_STOP) === 1) Atomics.wait(header, SAB_I_STOP, 1);
}

export function sleepFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sleepIn(ctx: EmContext, ms: number): void {
  if (ctx.init.sab instanceof SharedArrayBuffer || !(ms > 0)) {
    sleepFor(ms);
    return;
  }
  try {
    ctx.call({ op: 'fd-select', read: [], write: [], timeoutMs: ms });
  } catch (e) {
    if (errnoOf(e) === undefined) throw e;
  }
}

export function afterStopped(ctx: EmContext): void {
  const header = new Int32Array(ctx.init.sab, 0, SAB_HEADER_I32);
  holdStopped(ctx);
  const due =
    Atomics.load(header, SAB_I_SIGNALS) |
    Atomics.load(header, SAB_I_TIMERS) |
    Atomics.load(header, SAB_I_KILLED);
  if (due !== 0) ctx.gate.interrupt();
}

function envStrings(ctx: EmContext): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(ctx.init.env)) {
    if (value !== undefined) out.push(`${key}=${value}`);
  }
  return out;
}

const NODE_CLOCK = Boolean(
  (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node
);

function restarting(
  ctx: EmContext,
  fn: WasiFunction,
  args: number[] | Array<number | bigint>
): number {
  for (;;) {
    const r = (fn as (...a: unknown[]) => number | undefined)(...args) ?? 0;
    if (r !== EINTR || !ctx.gate.restartable()) return r;
  }
}

const STRERROR: Readonly<Record<string, string>> = {
  EACCES: 'Permission denied',
  EIO: 'I/O error',
  ENOTSUP: 'Not supported',
  EOPNOTSUPP: 'Not supported',
  EFBIG: 'File too large',
  EILSEQ: 'Illegal byte sequence',
  EINTR: 'Interrupted system call',
};

const REPORTING: ReadonlySet<string> = new Set(['clipboard', 'embedder']);

export function commitStdout(ctx: EmContext): void {
  const e = ctx.host.fds.find(1);
  if (e?.type !== 'kernel' || !REPORTING.has(ctx.host.fds.kind(1, e))) return;
  try {
    ctx.host.fds.close(1);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code !== 'string') throw err;
    ctx.quit.failed = true;
    try {
      ctx.sys.write(
        2,
        encoder.encode(`${ctx.init.argv0}: write error: ${STRERROR[code] ?? code}\n`)
      );
    } catch {}
  }
}

const WASI_NOTSUP = 58;

export function emscriptenErrno(errno: number): number {
  return errno === WASI_NOTSUP ? EM.NOTSUP : errno;
}

function emscriptenErrnos(fn: WasiFunction): WasiFunction {
  return ((...args: never[]) => emscriptenErrno(fn(...args) ?? 0)) as WasiFunction;
}

function streamed(ctx: EmContext, fd: number): boolean {
  const e = ctx.host.fds.find(fd);
  if (e?.type !== 'kernel') return false;
  const kind = ctx.host.fds.kind(fd, e);
  return kind !== 'file' && kind !== 'socket';
}

function streamWrite(ctx: EmContext): WasiFunction {
  return positive((fd: number, iov: number, n: number, out: number) => {
    const e = ctx.host.fds.get(fd);
    const nonblock = e.type === 'kernel' && e.nonblock;
    let written: number;
    try {
      written = ctx.sys.write(fd, ctx.mem.gather(iov, n), { nonblock });
    } catch (err) {
      if ((err as { code?: unknown }).code === 'EPIPE' && !sigpipeSpared(ctx)) {
        throw new WasiExit(KILLED_BY_SIGPIPE);
      }
      throw err;
    }
    ctx.mem.view().setUint32(out, written, true);
  }) as WasiFunction;
}

export function wasiImports(ctx: EmContext, state: FilesState): WebAssembly.ModuleImports {
  const host = ctx.host.imports();
  const { mem } = ctx;
  const call = (name: string): WasiFunction => emscriptenErrnos(host[name] as WasiFunction);
  return {
    fd_write: (fd: number, iov: number, n: number, out: number) => {
      holdStopped(ctx);
      const r = streamed(ctx, fd)
        ? restarting(ctx, streamWrite(ctx), [fd, iov, n, out])
        : restarting(ctx, call('fd_write'), [fd, iov, n, out]);
      afterStopped(ctx);
      return r;
    },
    fd_read: (fd: number, iov: number, n: number, out: number) => {
      holdStopped(ctx);
      const r = restarting(ctx, call('fd_read'), [fd, iov, n, out]);
      afterStopped(ctx);
      return r;
    },
    fd_pread: (fd: number, iov: number, n: number, at: bigint, out: number) => {
      if (at < 0n || at > BigInt(Number.MAX_SAFE_INTEGER)) return EM.OVERFLOW;
      return call('fd_pread')(...([fd, iov, n, at, out] as never[])) ?? 0;
    },
    fd_pwrite: (fd: number, iov: number, n: number, at: bigint, out: number) => {
      if (at < 0n || at > BigInt(Number.MAX_SAFE_INTEGER)) return EM.OVERFLOW;
      return call('fd_pwrite')(...([fd, iov, n, at, out] as never[])) ?? 0;
    },
    fd_close: (fd: number) => {
      const e = ctx.host.fds.find(fd);
      if (e) state.listings.delete(e);
      if (fd === 2 && ctx.quit.atExit) commitStdout(ctx);
      return call('fd_close')(...([fd] as never[])) ?? 0;
    },
    fd_seek: positive((fd: number, offset: bigint, whence: number, out: number) => {
      const e = ctx.host.fds.get(fd);
      if (e.type === 'dir') {
        const pos = seekDir(state, e, Number(offset), whence);
        mem.view().setBigInt64(out, BigInt(pos), true);
        return 0;
      }
      return call('fd_seek')(...([fd, offset, whence, out] as never[])) ?? 0;
    }),
    fd_sync: positive((fd: number) => {
      const e = ctx.host.fds.get(fd);
      if (e.type === 'file') ctx.host.fds.synced(e.file);
      else if (e.type === 'kernel' && ctx.host.fds.kind(fd, e) === 'file') ctx.sys.flush(fd);
    }),
    fd_fdstat_get: positive((fd: number, out: number) => {
      const e = ctx.host.fds.get(fd);
      let type = 4;
      if (e.type === 'dir') type = 3;
      else if (e.type === 'kernel' && ctx.host.fds.kind(fd, e) === 'tty') type = 2;
      const v = mem.view();
      v.setInt8(out, type);
      v.setInt16(out + 2, 0, true);
      v.setBigInt64(out + 8, 0n, true);
      v.setBigInt64(out + 16, 0n, true);
    }),
    environ_sizes_get: (count: number, size: number) => {
      const list = envStrings(ctx);
      let bytes = 0;
      for (const s of list) bytes += encoder.encode(s).length + 1;
      const v = mem.view();
      v.setUint32(count, list.length, true);
      v.setUint32(size, bytes, true);
      return 0;
    },
    environ_get: (envp: number, buf: number) => {
      const list = envStrings(ctx);
      let at = buf;
      for (let i = 0; i < list.length; i++) {
        const bytes = encoder.encode(list[i]);
        mem.view().setUint32(envp + i * 4, at, true);
        mem.bytes(at, bytes.length + 1).set(bytes);
        mem.bytes(at + bytes.length, 1)[0] = 0;
        at += bytes.length + 1;
      }
      return 0;
    },
    clock_time_get: (id: number, _precision: bigint, out: number) => {
      lookedOutside();
      if (id < 0 || id > 3) return EM.INVAL;
      const now = id === 0 ? Date.now() : performance.now();
      mem.view().setBigInt64(out, BigInt(Math.round(now * 1000 * 1000)), true);
      return 0;
    },
    clock_res_get: (id: number, out: number) => {
      if (id < 0 || id > 3) return EM.INVAL;
      const nsec = id === 0 ? 1000 * 1000 : NODE_CLOCK ? 1 : 1000;
      mem.view().setBigInt64(out, BigInt(nsec), true);
      return 0;
    },
    random_get: (buf: number, len: number) => {
      lookedOutside();
      for (let at = 0; at < len; at += 65536) {
        const chunk = new Uint8Array(Math.min(65536, len - at));
        crypto.getRandomValues(chunk);
        mem.bytes(buf + at, chunk.length).set(chunk);
      }
      return 0;
    },
    proc_exit: (code: number) => {
      throw new WasiExit(code);
    },
  };
}
