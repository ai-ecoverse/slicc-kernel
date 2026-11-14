import type { DeviceNodeInfo } from '../../kernel/devices.ts';
import type { MountLine, ProcessListing } from '../../kernel/proc-info.ts';
import type { WasmSyscall } from '../../kernel/process.ts';
import { WASM_PROCESS_READY, type WasmProcessInitMsg } from '../../kernel/protocol.ts';
import { SIG } from '../../kernel/signals.ts';
import type { SyncFsResult } from '../../realm/sync-fs-wire.ts';
import {
  createSyncFsSabBridge,
  createSyncSabTransport,
  type SabPostLike,
} from '../../realm/sync-sab-bridge.ts';
import { publishMemory, SAB_HEADER_I32 } from '../../realm/sync-sab-wire.ts';
import { SyscallError } from '../kernel-streams.ts';
import { identify, kernelSys, signalMasks } from '../process-runtime.ts';
import { SignalGate } from '../process-signals.ts';
import type { WasiForkFd } from '../wasi/wasi-fds.ts';
import { cachingBridge } from '../wasi/wasi-files.ts';
import { WasiExit, WasiHost } from '../wasi/wasi-host.ts';
import { ProcTree, procfsBridge } from '../wasi/wasi-procfs.ts';
import { ptsBridge } from '../wasi/wasi-ptsfs.ts';
import { createImportedMemory, type TransportFactory, wireSignals } from '../wasi/wasi-runtime.ts';
import { sysfsBridge } from '../wasi/wasi-sysfs.ts';
import type { EmContext, EmExports } from './context.ts';
import { EmCwd } from './cwd.ts';
import { dnsImports } from './dns.ts';
import { EM, EmError } from './errno.ts';
import { fdImports } from './fds.ts';
import { type FilesState, fileImports } from './files.ts';
import { EmFork } from './fork.ts';
import { putString } from './layout.ts';
import { invoke, invokeImports } from './longjmp.ts';
import { mmapImport } from './mmap.ts';
import { netImports } from './net.ts';
import { procImports } from './proc.ts';
import { pthreadImports } from './pthread.ts';
import { Reentry, type WasmExport } from './reentry.ts';
import { timeImports } from './time.ts';
import { commitStdout, wasiImports } from './wasi.ts';

const NOT_RUNNABLE = 126;
const HEAP_MAX = 2147483648;

function procTree(call: (req: WasmSyscall) => unknown, pid: number): ProcTree {
  return new ProcTree(
    {
      procList: () => call({ op: 'proc-list' }) as ProcessListing,
      mountList: () => call({ op: 'mount-list' }) as MountLine[],
    },
    pid
  );
}

function ownersOf(init: WasmProcessInitMsg) {
  return {
    ...(init.owners ? { owners: true } : {}),
    ...(init.links ? { links: true } : {}),
    ...(init.changes ? { changes: init.changes } : {}),
  };
}

const O_NONBLOCK = 0o4000;
const O_APPEND = 0o2000;

function stdioEntries(
  init: WasmProcessInitMsg,
  call: (req: WasmSyscall) => unknown
): { fds: WasiForkFd[]; cloexec: number[] } {
  const fds: WasiForkFd[] = [];
  const cloexec: number[] = [];
  for (let fd = 0; fd < 3; fd++) {
    let info: { meta?: { dir?: string } } | undefined;
    try {
      info = call({ op: 'fd-info', fd }) as { meta?: { dir?: string } } | undefined;
    } catch {
      info = undefined;
    }
    const dir = info?.meta?.dir;
    if (dir !== undefined) fds.push({ fd, type: 'dir', path: dir });
    else fds.push({ fd, type: 'kernel', nonblock: false, append: false });
  }
  for (const entry of init.fds ?? []) {
    if (entry.fd <= 2) continue;
    if (entry.device) {
      const access = entry.device.access ? { access: entry.device.access } : {};
      fds.push({ fd: entry.fd, type: 'device', device: entry.device.device, ...access });
    } else {
      const flags = entry.flags ?? 0;
      fds.push({
        fd: entry.fd,
        type: 'kernel',
        nonblock: (flags & O_NONBLOCK) !== 0,
        append: (flags & O_APPEND) !== 0,
      });
    }
    if (entry.cloexec) cloexec.push(entry.fd);
  }
  return { fds, cloexec };
}

const PROVIDED_ELSEWHERE = new Set(['memory']);

function missingImports(module: WebAssembly.Module, imports: WebAssembly.Imports): string[] {
  const missing: string[] = [];
  for (const imp of WebAssembly.Module.imports(module)) {
    const ns = imports[imp.module] as Record<string, unknown> | undefined;
    if (imp.kind === 'function' && typeof ns?.[imp.name] === 'function') continue;
    if (imp.kind !== 'function' && PROVIDED_ELSEWHERE.has(imp.kind) && ns?.[imp.name]) continue;
    missing.push(`${imp.module}.${imp.name}`);
  }
  return missing;
}

function importsCred(module: WebAssembly.Module): boolean {
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module === 'env' && imp.name === 'slicc_cred_js') return true;
  }
  return false;
}

class EmRuntime {
  readonly reentry = new Reentry();
  private ex: EmExports | undefined;
  up = false;
  private exiting = false;
  readonly seeded = { bits: 0 };
  fork: EmFork | undefined;
  ctx: EmContext | undefined;

  exports(): EmExports {
    if (!this.ex) throw new Error('emscripten: no instance yet');
    return this.ex;
  }

  bind(exports: WebAssembly.Exports, imported?: WebAssembly.Memory): void {
    const own = exports as unknown as EmExports;
    this.ex = imported && !own.memory ? { ...own, memory: imported } : own;
    this.reentry.bind(exports);
  }

  enter(name: string, fn: WasmExport, args: readonly unknown[]): unknown {
    return this.reentry.enter(name, fn, args);
  }

  masks() {
    const mask = this.ex?.slicc_sig_mask;
    const sliccSigMask = (w: number) => (this.up && mask ? mask(w) : -1);
    return signalMasks({ sliccSigMask }, this.seeded);
  }

  raise(sig: number): void {
    const fn = this.ex?.slicc_raise;
    if (this.up && typeof fn === 'function') this.enter('slicc_raise', fn as WasmExport, [sig]);
  }

  timer(which: number): void {
    const fn = this.ex?._emscripten_timeout;
    if (!this.up || typeof fn !== 'function') {
      this.raise(SIG.ALRM);
      return;
    }
    this.enter('_emscripten_timeout', fn as WasmExport, [which, performance.now()]);
  }

  exit(status: number): never {
    if (!this.exiting) {
      this.exiting = true;
      const atexit = this.ex?.__funcs_on_exit;
      const quit = this.ctx?.quit;
      if (quit) quit.atExit = true;
      if (typeof atexit === 'function') this.enter('__funcs_on_exit', atexit as WasmExport, []);
      const flush = this.ex?.fflush;
      if (typeof flush === 'function') this.enter('fflush', flush as WasmExport, [0]);
      if (this.ctx) commitStdout(this.ctx);
      if (quit) quit.atExit = false;
      this.up = false;
    }
    throw new WasiExit(this.ctx?.quit.failed && status === 0 ? 1 : status);
  }
}

function abort(ctx: EmContext, what: string): never {
  ctx.say(`Aborted(${what})`);
  throw new WebAssembly.RuntimeError(`Aborted(${what}). Build with -sASSERTIONS for more info.`);
}

function resizeHeap(ctx: EmContext, requested: number): number {
  const memory = ctx.exports().memory;
  const old = memory.buffer.byteLength;
  const size = requested >>> 0;
  if (size > HEAP_MAX) return 0;
  for (let cutDown = 1; cutDown <= 4; cutDown *= 2) {
    let over = old * (1 + 0.2 / cutDown);
    over = Math.min(over, size + 100663296);
    const next = Math.min(HEAP_MAX, Math.ceil(Math.max(size, over) / 65536) * 65536);
    const pages = ((next - memory.buffer.byteLength + 65535) / 65536) | 0;
    try {
      memory.grow(pages);
      publishMemory(ctx.init.sab, memory.buffer.byteLength);
      return 1;
    } catch {}
  }
  return 0;
}

function runtimeImports(ctx: EmContext, rt: EmRuntime): WebAssembly.ModuleImports {
  const { mem } = ctx;
  const sighandler = invoke(ctx, 'vi');
  return {
    exit: (status: number) => rt.exit(status),
    _abort_js: () => abort(ctx, ''),
    __assert_fail: (cond: number, file: number, line: number, func: number) =>
      abort(
        ctx,
        `Assertion failed: ${mem.cString(cond)}, at: ${[
          file ? mem.cString(file) : 'unknown filename',
          line,
          func ? mem.cString(func) : 'unknown function',
        ].join(',')}`
      ),
    emscripten_resize_heap: (size: number) => resizeHeap(ctx, size),
    emscripten_get_heap_max: () => HEAP_MAX,
    _emscripten_runtime_keepalive_clear: () => {},
    _emscripten_get_progname: (str: number, len: number) =>
      putString(mem, str, ctx.init.argv0 || './this.program', len),
    _emscripten_throw_longjmp: () => {
      throw Number.POSITIVE_INFINITY;
    },
    __call_sighandler: (fp: number, sig: number) => {
      const ex = ctx.exports();
      if (typeof ex.dynCall_vi === 'function') return sighandler(fp, sig);
      const fn = ex.__indirect_function_table?.get(fp) as WasmExport | null | undefined;
      if (typeof fn !== 'function') throw new WebAssembly.RuntimeError('null function');
      ctx.enter(`table:${fp}`, fn, [sig]);
    },
    _setitimer_js: (which: number, ms: number) => {
      if (which !== 0) return 0;
      ctx.call({ op: 'proc-alarm', sig: SIG.ALRM, ms: ms ?? 0, repeat: false, timer: 0 });
      return 0;
    },
    slicc_webcrypto_random: (out: number, len: number) => {
      for (let at = 0; at < len; at += 65536) {
        crypto.getRandomValues(
          mem.bytes(out + at, Math.min(65536, len - at)) as Uint8Array<ArrayBuffer>
        );
      }
      return 0;
    },
    slicc_fork_js: () => {
      if (!rt.fork) return -1;
      if (!rt.fork.supported()) return rt.fork.failed(-EM.NOSYS);
      return rt.fork.forkImport();
    },
  };
}

function buildImports(
  ctx: EmContext,
  rt: EmRuntime,
  module: WebAssembly.Module
): WebAssembly.Imports {
  const state: FilesState = { listings: new WeakMap() };
  const env: WebAssembly.ModuleImports = {
    ...fileImports(ctx, state),
    ...fdImports(ctx),
    ...procImports(ctx, { seeded: rt.seeded, raise: (sig) => rt.raise(sig) }),
    ...timeImports(ctx),
    ...netImports(ctx),
    ...mmapImport(ctx),
    ...dnsImports(ctx),
    ...pthreadImports(ctx),
    ...runtimeImports(ctx, rt),
    ...invokeImports(ctx, module),
  };
  const preview1 = wasiImports(ctx, state);
  if (ctx.init.env.SLICC_EMSCRIPTEN_TRACE === '1') {
    for (const table of [env, preview1]) {
      for (const [name, fn] of Object.entries(table)) {
        if (typeof fn !== 'function' || name.startsWith('invoke_')) continue;
        table[name] = (...args: unknown[]) => {
          const r = (fn as (...a: unknown[]) => unknown)(...args);
          ctx.say(`[em] ${name}(${args.map(String).join(',')}) = ${String(r)}`);
          return r;
        };
      }
    }
  }
  return {
    env: env as WebAssembly.ModuleImports,
    wasi_snapshot_preview1: preview1 as WebAssembly.ModuleImports,
  };
}

function argvOnStack(ctx: EmContext, args: readonly string[]): number {
  const ex = ctx.exports();
  const alloc = ex._emscripten_stack_alloc as (n: number) => number;
  const argv = alloc((args.length + 1) * 4);
  const encoder = new TextEncoder();
  for (let i = 0; i < args.length; i++) {
    const bytes = encoder.encode(args[i]);
    const at = alloc(bytes.length + 1);
    ctx.mem.bytes(at, bytes.length + 1).set(bytes);
    ctx.mem.bytes(at + bytes.length, 1)[0] = 0;
    ctx.mem.view().setUint32(argv + i * 4, at, true);
  }
  ctx.mem.view().setUint32(argv + args.length * 4, 0, true);
  return argv;
}

function runMain(ctx: EmContext, rt: EmRuntime): number {
  const ex = ctx.exports();
  const args = [ctx.init.argv0, ...ctx.init.args];
  const name = typeof ex.main === 'function' ? 'main' : '__main_argc_argv';
  const main = ex[name];
  if (typeof main !== 'function') throw new Error(`${ctx.init.argv0}: exports no main`);
  const argv = argvOnStack(ctx, args);
  const ret = ctx.enter(name, main as WasmExport, [args.length, argv]);
  const settled = rt.fork ? rt.fork.settle(ret) : ret;
  return rt.exit(Number(settled ?? 0));
}

const sabTransport: TransportFactory = (sab, port, memory) =>
  createSyncSabTransport(sab, port, memory ? { memory } : {});

export async function runEmscriptenProcess(
  init: WasmProcessInitMsg,
  port: SabPostLike,
  given: { transport?: TransportFactory } = {}
): Promise<number> {
  const rt = new EmRuntime();
  let memory: WebAssembly.Memory | undefined;
  const transports = given.transport ?? sabTransport;
  const gate = new SignalGate(
    transports(init.sab, port, () => memory?.buffer.byteLength ?? 0),
    new Int32Array(init.sab, 0, SAB_HEADER_I32),
    {
      masks: () => rt.masks(),
      raise: (sig) => rt.raise(sig),
      timer: (which) => rt.timer(which),
    }
  );
  const transport = gate.transport();
  const sys = kernelSys(transport);
  const call = (req: WasmSyscall): unknown => {
    const r: SyncFsResult = transport.call(req, Number.POSITIVE_INFINITY, req.op);
    if (!r.ok) throw new SyscallError(r.errno);
    return r.kind === 'json' ? r.json : r.kind === 'bytes' ? r.bytes : undefined;
  };
  const encoder = new TextEncoder();
  const say = (text: string) => void sys.write(2, encoder.encode(`${text}\n`));
  const id = identify(transport, init);
  const fork = init.fork?.wasi;
  const raw = createSyncFsSabBridge(transport, { ...ownersOf(init), direct: true });
  const host = new WasiHost({
    args: [init.argv0, ...init.args],
    env: init.env,
    cwd: fork?.cwd ?? init.cwd,
    pid: id.pid,
    ppid: id.ppid,
    parent: () => identify(transport, init).ppid,
    kernel: { sys, call },
    fs: ptsBridge(
      sysfsBridge(
        procfsBridge(cachingBridge(raw), procTree(call, id.pid)),
        () => call({ op: 'fd-dev-nodes' }) as DeviceNodeInfo[]
      ),
      call
    ),
    bare: true,
  }).attach();
  if (fork) host.fds.restore(fork.fds, fork.cloexec);
  else {
    const { fds, cloexec } = stdioEntries(init, call);
    host.fds.restore(fds, cloexec);
  }
  wireSignals(host, gate);
  const cwd = new EmCwd(host, fork?.cwd ?? init.cwd, call, init.held);
  const ctx: EmContext = {
    init,
    host,
    mem: host.mem,
    sys,
    transport,
    gate,
    cwd,
    reentry: rt.reentry,
    pid: init.pid,
    ppid: id.ppid,
    credAbi: importsCred(init.program.module),
    statfs: (path) => raw.statfs?.(path) ?? null,
    quit: { atExit: false, failed: false },
    call,
    exports: () => rt.exports(),
    enter: (name, fn, args) => rt.enter(name, fn, args),
    exit: (status) => rt.exit(status),
    say,
  };
  rt.ctx = ctx;
  const { module } = init.program;
  const imports = buildImports(ctx, rt, module);
  const spec = init.program.memory;
  const imported = createImportedMemory(spec);
  if (spec && imported) (imports[spec.module] ??= {})[spec.name] = imported;
  const missing = missingImports(module, imports);
  if (missing.length > 0) {
    say(
      `${init.argv0}: cannot start: the kernel's Emscripten runtime does not provide ${missing.join(', ')}`
    );
    return NOT_RUNNABLE;
  }
  const instance = await WebAssembly.instantiate(module, imports);
  rt.bind(instance.exports, imported);
  memory = rt.exports().memory;
  host.mem.bind(memory);
  publishMemory(init.sab, memory.buffer.byteLength);
  port.postMessage({ type: WASM_PROCESS_READY });
  rt.fork = new EmFork(ctx);
  try {
    rt.up = true;
    const ctors = instance.exports.__wasm_call_ctors;
    if (typeof ctors === 'function') rt.enter('__wasm_call_ctors', ctors as WasmExport, []);
    if (init.fork) {
      if (!rt.fork.supported()) throw new EmError(EM.NOSYS);
      const ret = rt.fork.child(init.fork);
      return rt.exit(Number(ret ?? 0));
    }
    return runMain(ctx, rt);
  } catch (e) {
    if (e instanceof WasiExit) return e.code;
    throw e;
  } finally {
    rt.up = false;
    try {
      host.flushAll();
    } catch {}
  }
}
