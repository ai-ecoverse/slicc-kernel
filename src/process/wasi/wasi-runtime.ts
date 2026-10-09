import type { WasmSyscall } from '../../kernel/process.ts';
import {
  WASM_PROCESS_EXIT,
  type WasmProcessInitMsg,
  type WasmProgram,
  type WasmThreadInitMsg,
} from '../../kernel/protocol.ts';
import type { SyncFsResult } from '../../realm/sync-fs-wire.ts';
import {
  createSyncFsSabBridge,
  createSyncSabTransport,
  type SabPostLike,
} from '../../realm/sync-sab-bridge.ts';
import { publishMemory, SAB_HEADER_I32 } from '../../realm/sync-sab-wire.ts';
import { SyscallError } from '../kernel-streams.ts';
import { kernelSys } from '../process-runtime.ts';
import { SignalGate, type SignalHooks } from '../process-signals.ts';
import { dylinkInfo } from './dylink.ts';
import { cachingBridge } from './wasi-files.ts';
import { WasiExit, type WasiFunction, WasiHost, type WasiHostOptions } from './wasi-host.ts';
import { importsContext, loadImports, type ProgramImports, type Raw } from './wasi-imports.ts';
import { type ForeignResults, type ImportedMemory, RESERVED_NAMESPACES } from './wasi-module.ts';
import { WasiSignals } from './wasi-signals.ts';
import { WasiStats } from './wasi-stats.ts';
import { MAIN_TID, ThreadExit, threadCap, WasiThreads } from './wasi-threads.ts';
import { AsyncifyDriver, type WasiForkState } from './wasix-fork.ts';
import { WasixHost } from './wasix-host.ts';
import { type LinkerHost, type LinkRecord, WasixLinker } from './wasix-linker.ts';
import { mainModule, nameFrame, sidecarNames } from './wasm-names.ts';

type ProgramOption = (
  memory: () => WebAssembly.Memory,
  instance: () => WebAssembly.Instance | undefined
) => ProgramImports;

const TRAPPED = 134;

const PREVIEW1 = 'wasi_snapshot_preview1';
const WASIX = 'wasix_32v1';
const SLICC = 'slicc';

const RESERVED = RESERVED_NAMESPACES;

const noErrno = (key: string) =>
  `imports ${key}: its result cannot carry ENOSYS, and this host does not provide it`;

function enosys(module: string, name: string, foreign: ForeignResults | undefined) {
  const type = foreign?.[module]?.[name];
  if (type === 'other') throw new Error(noErrno(`${module}.${name}`));
  if (type === 'none') return () => undefined;
  if (type === 'i64') return () => 52n;
  return () => 52;
}

function firstOther(foreign: ForeignResults): string | undefined {
  for (const [module, fields] of Object.entries(foreign)) {
    const name = Object.keys(fields).find((field) => fields[field] === 'other');
    if (name !== undefined) return `${module}.${name}`;
  }
  return undefined;
}

interface ImportScope {
  extended: boolean;
  wasi: boolean;
  wasix: boolean;
  pie: boolean;
  memory: ImportedMemory | undefined;
}

function accepted(imp: WebAssembly.ModuleImportDescriptor, scope: ImportScope): boolean {
  const { module, name, kind } = imp;
  if (module === PREVIEW1 || module === WASIX) return true;
  if (!RESERVED.has(module) && (scope.extended || (scope.wasi && kind === 'function'))) return true;
  if (scope.pie && (module === 'GOT.mem' || module === 'GOT.func')) return true;
  if (scope.pie && module === 'env' && kind !== 'memory') return true;
  if (kind === 'memory' && scope.memory?.module === module && scope.memory.name === name)
    return true;
  return module === 'wasi' && name === 'thread-spawn' && (scope.wasix || !!scope.memory?.shared);
}

export function unsupportedImport(
  module: WebAssembly.Module,
  memory?: ImportedMemory,
  extended = false,
  foreign: ForeignResults = {}
): string | undefined {
  const imports = WebAssembly.Module.imports(module);
  const wasix = imports.some((i) => i.module === WASIX);
  const wasi = wasix || imports.some((i) => i.module === PREVIEW1);
  const scope = { extended, wasi, wasix, pie: dylinkInfo(module) !== undefined, memory };
  const refused = imports.find((imp) => !accepted(imp, scope));
  if (refused) {
    if (refused.kind === 'memory' || refused.module === 'wasi') {
      return `imports ${refused.module}.${refused.name}: no WASI program this host runs`;
    }
    return `imports ${refused.module}.${refused.name}: no WASI preview1 program (an Emscripten one runs with its glue)`;
  }
  const unanswerable = extended ? undefined : firstOther(foreign);
  if (unanswerable) return noErrno(unanswerable);
  if (!WebAssembly.Module.exports(module).some((e) => e.name === '_start')) {
    return 'no WASI command (it exports no _start)';
  }
  return undefined;
}

function linkImports(
  module: WebAssembly.Module,
  preview1: Record<string, WasiFunction>,
  wasix: Record<string, WasiFunction> | undefined,
  memory: WebAssembly.Memory | undefined,
  threads: WasiThreads | undefined,
  program: ProgramImports = {},
  foreign?: ForeignResults,
  slicc: Record<string, WasiFunction> = {}
): WebAssembly.Imports {
  for (const ns of Object.keys(program)) {
    if (RESERVED.has(ns) || ns === SLICC)
      throw new Error(`the imports module may not define ${ns}`);
  }
  const imports: Record<string, Record<string, WebAssembly.ImportValue>> = {
    ...program,
    [SLICC]: { ...slicc },
    [PREVIEW1]: preview1,
    ...(wasix ? { [WASIX]: { ...wasix } } : {}),
    ...(threads ? { wasi: { 'thread-spawn': (arg: number) => threads.spawn(arg) } } : {}),
  };
  for (const imp of WebAssembly.Module.imports(module)) {
    const ns = (imports[imp.module] ??= {});
    if (imp.name in ns) continue;
    if (imp.kind === 'memory' && memory) ns[imp.name] = memory;
    else if (imp.module === 'wasi' && imp.name === 'thread-spawn') ns[imp.name] = () => -1;
    else if (imp.kind === 'function') ns[imp.name] = enosys(imp.module, imp.name, foreign);
  }
  return imports;
}

export const FALLBACK_MAXIMUM_PAGES = 32768;

function newImportedMemory(spec: ImportedMemory): WebAssembly.Memory {
  const maximum = spec.maximum ?? 65536;
  try {
    return new WebAssembly.Memory({ initial: spec.initial, maximum, shared: spec.shared });
  } catch (err) {
    if (!(err instanceof RangeError) || maximum <= FALLBACK_MAXIMUM_PAGES) throw err;
    if (spec.initial > FALLBACK_MAXIMUM_PAGES) throw err;
    return new WebAssembly.Memory({
      initial: spec.initial,
      maximum: FALLBACK_MAXIMUM_PAGES,
      shared: spec.shared,
    });
  }
}

export function createImportedMemory(
  spec: ImportedMemory | undefined,
  copy?: Uint8Array
): WebAssembly.Memory | undefined {
  if (!spec) return undefined;
  const memory = newImportedMemory(spec);
  if (copy) fillMemory(memory, copy);
  return memory;
}

function restoreExportedMemory(
  instance: WebAssembly.Instance,
  imported: WebAssembly.Memory | undefined,
  init: WasmProcessInitMsg
): void {
  if (imported || !init.fork?.wasi) return;
  fillMemory(instance.exports.memory as WebAssembly.Memory, init.fork.memory);
}

function fillMemory(memory: WebAssembly.Memory, copy: Uint8Array): void {
  const pages = copy.byteLength / 65536 - memory.buffer.byteLength / 65536;
  if (pages > 0) memory.grow(pages);
  new Uint8Array(memory.buffer).set(copy);
}

function sizeOf(main: { memory?: WebAssembly.Memory }): () => number {
  return () => main.memory?.buffer.byteLength ?? 0;
}

function memoryOf(
  instance: WebAssembly.Instance,
  imported: WebAssembly.Memory | undefined
): WebAssembly.Memory | undefined {
  return imported ?? (instance.exports.memory as WebAssembly.Memory | undefined);
}

function kernelOf(
  init: { sab: SharedArrayBuffer; argv0: string },
  port: SabPostLike,

  hooks: SignalHooks = { masks: () => null, raise: () => {} },
  memory?: () => number
) {
  const transport = new SignalGate(
    createSyncSabTransport(init.sab, port, memory ? { memory } : {}),
    new Int32Array(init.sab, 0, SAB_HEADER_I32),
    hooks
  ).transport();
  const sys = kernelSys(transport);
  const call = (req: WasmSyscall): unknown => {
    const r: SyncFsResult = transport.call(req, Number.POSITIVE_INFINITY, req.op);
    if (!r.ok) throw new SyscallError(r.errno);
    return r.kind === 'json' ? r.json : undefined;
  };
  const say = (text: string) => sys.write(2, new TextEncoder().encode(`${init.argv0}: ${text}\n`));
  return { transport, sys, call, say };
}

function traced<T extends object>(stats: WasiStats | undefined, tag: string, table: T): T {
  return stats ? stats.wrap(tag, table) : table;
}

function timedCalls(stats: WasiStats, call: (req: WasmSyscall) => unknown) {
  return (req: WasmSyscall): unknown => stats.time(`kernel.${req.op}`, () => call(req));
}

function report(stats: WasiStats, sys: { write(fd: number, bytes: Uint8Array): unknown }): void {
  stats.phase('run');
  try {
    sys.write(2, new TextEncoder().encode(stats.report()));
  } catch {}
}

function spawnsThreads(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).some(
    (i) =>
      (i.module === 'wasi' && i.name === 'thread-spawn') ||
      (i.module === WASIX && i.name === 'thread_spawn_v2')
  );
}

async function instantiate(
  host: WasiHost,
  module: WebAssembly.Module,
  memory: WebAssembly.Memory | undefined,
  threads: WasiThreads | undefined,
  {
    thread = false,
    stats,
    signals,
    program,
    foreign,
  }: {
    thread?: boolean;
    stats?: WasiStats;
    signals?: WasiSignals;
    program?: ProgramOption;
    foreign?: ForeignResults | undefined;
  } = {}
): Promise<{ instance: WebAssembly.Instance; driver: AsyncifyDriver }> {
  const driver = new AsyncifyDriver(host.mem);
  const wasixHost = WebAssembly.Module.imports(module).some((i) => i.module === WASIX)
    ? new WasixHost(host, driver, module)
    : undefined;
  if (wasixHost) {
    wasixHost.threads = threads;
    wasixHost.signals = signals;
  }
  let preview1: Record<string, WasiFunction> = traced(stats, 'wasi', {
    ...host.imports(),
    ...wasixHost?.preview1(),
  });
  let wasix = wasixHost && traced(stats, 'wasix', wasixHost.imports());

  const info = dylinkInfo(module);
  const sync: LinkSync | undefined =
    info && memory
      ? new LinkSync(
          new WasixLinker(
            memory,
            info,
            linkerHost(host, (): WebAssembly.Imports => imports),
            thread
          ),
          (req) => host.o.kernel.call(req),
          threads?.ids
        )
      : undefined;
  if (sync) {
    ({ preview1, wasix } = sync.guard(preview1, wasix));
    if (wasixHost) wasixHost.linker = sync.linker;

    if (threads) {
      sync.linker.cache = threads.received;
      threads.modules = () => sync.linker.compiled();
    }
  }
  let instance: WebAssembly.Instance | undefined;
  const extra = program?.(
    () => memory ?? (instance?.exports.memory as WebAssembly.Memory),
    () => instance
  );
  const slicc = traced(stats, 'slicc', host.sliccImports());
  const hostImports = linkImports(module, preview1, wasix, memory, threads, extra, foreign, slicc);
  const imports: WebAssembly.Imports = sync
    ? merge(hostImports, sync.linker.mainImports(module))
    : hostImports;
  instance = await WebAssembly.instantiate(module, imports);
  stats?.phase('instantiate');
  const exports = instance.exports as { memory?: WebAssembly.Memory };
  host.mem.bind(memory ?? (exports.memory as WebAssembly.Memory));
  if (sync) {
    sync.linker.bindMain(instance, !thread);

    if (thread) sync.catchUp();

    sync.linker.bindMainGot();
  }
  return { instance, driver };
}

function linkerHost(host: WasiHost, imports: () => WebAssembly.Imports): LinkerHost {
  return {
    read: (path) => {
      try {
        return host.o.fs.readFile(path) as Uint8Array<ArrayBuffer>;
      } catch {
        return undefined;
      }
    },
    hostImports: () => {
      const { env: _env, 'GOT.mem': _mem, 'GOT.func': _func, ...rest } = imports();
      return rest;
    },
  };
}

function merge(
  base: WebAssembly.Imports,
  extra: Record<string, Record<string, WebAssembly.ImportValue>>
): WebAssembly.Imports {
  const out: WebAssembly.Imports = { ...base };
  for (const [ns, values] of Object.entries(extra)) out[ns] = { ...base[ns], ...values };
  return out;
}

class LinkSync {
  private count = 0;
  private gen = 0;

  readonly linker: WasixLinker;
  private readonly call: (req: WasmSyscall) => unknown;
  private readonly ids: Int32Array | undefined;
  constructor(
    linker: WasixLinker,
    call: (req: WasmSyscall) => unknown,
    ids: Int32Array | undefined
  ) {
    this.linker = linker;
    this.call = call;
    this.ids = ids;
    linker.publisher = (record) => this.publish(record);
  }

  private publish(record: LinkRecord): void {
    const since = this.call({ op: 'dl-log', append: record, from: this.count }) as LinkRecord[];

    for (const r of since.slice(0, -1)) this.linker.replay(r);
    this.count += since.length;
    if (this.ids) this.gen = Atomics.add(this.ids, DL_GEN, 1) + 1;
  }

  catchUp(): void {
    const since = this.call({ op: 'dl-log', from: this.count }) as LinkRecord[];
    for (const r of since) this.linker.replay(r);
    this.count += since.length;
    if (this.ids) this.gen = Atomics.load(this.ids, DL_GEN);
  }

  guard(
    preview1: Record<string, WasiFunction>,
    wasix: Record<string, WasiFunction> | undefined
  ): { preview1: Record<string, WasiFunction>; wasix: Record<string, WasiFunction> | undefined } {
    const ids = this.ids;
    if (!ids) return { preview1, wasix };
    const wrap = (table: Record<string, WasiFunction>) =>
      Object.fromEntries(
        Object.entries(table).map(([name, fn]) => [
          name,
          ((...args: never[]) => {
            if (Atomics.load(ids, DL_GEN) !== this.gen) this.catchUp();

            const result = fn(...args);
            if (Atomics.load(ids, DL_GEN) !== this.gen) this.catchUp();
            return result;
          }) as WasiFunction,
        ])
      );
    return { preview1: wrap(preview1), wasix: wasix && wrap(wasix) };
  }
}

const DL_GEN = 3;

function descriptors(
  init: WasmProcessInitMsg,
  fork: WasiForkState | undefined,
  threads: WasiThreads | undefined
): Pick<WasiHostOptions, 'shared' | 'forked' | 'inherited' | 'preopenRoot'> {
  if (fork?.shared && threads) return { shared: threads.ids };
  if (fork) return { forked: { fds: fork.fds, cloexec: fork.cloexec } };
  return { inherited: init.fds ?? [], ...(init.program.preopenRoot ? { preopenRoot: true } : {}) };
}

export async function runWasiProcess(init: WasmProcessInitMsg, port: SabPostLike): Promise<number> {
  captureBacktraces(init.env);

  const signals = new WasiSignals((sig) => {
    call({ op: 'proc-kill', pid: init.pid, sig });
    throw new WasiExit(128 + sig);
  });
  const main: { memory?: WebAssembly.Memory } = {};
  const { transport, sys, call: kernelCall, say } = kernelOf(init, port, signals, sizeOf(main));

  const stats = init.env.SLICC_WASI_STATS === '1' ? new WasiStats() : undefined;
  const call = stats ? timedCalls(stats, kernelCall) : kernelCall;
  const { module } = init.program;
  const refused = unsupportedImport(
    module,
    init.program.memory,
    init.program.imports !== undefined,
    init.program.foreign
  );
  if (refused) {
    say(refused);
    return 126;
  }
  const fork = init.fork?.wasi;
  const memory = createImportedMemory(init.program.memory, fork ? init.fork?.memory : undefined);
  const threads =
    memory?.buffer instanceof SharedArrayBuffer && spawnsThreads(module)
      ? new WasiThreads(port, memory, threadCap(init.env), MAIN_TID)
      : undefined;
  const host = new WasiHost({
    args: [init.argv0, ...init.args],
    env: init.env,
    cwd: fork?.cwd ?? init.cwd,
    pid: init.pid,
    ...(init.ppid !== undefined ? { ppid: init.ppid } : {}),
    kernel: { sys: traced(stats, 'kernel', sys), call },
    fs: cachingBridge(traced(stats, 'fs', createSyncFsSabBridge(transport))),
    ...descriptors(init, fork, threads),
  });
  if (threads) {
    threads.beforeSpawn = () => {
      if (!host.fds.isShared) host.fds.share(threads.ids, false);
    };
  }
  const program = await programImports(init.program, host, transport, MAIN_TID);
  const { instance, driver } = await instantiate(host, module, memory, threads, {
    stats,
    signals,
    foreign: init.program.foreign,
    ...(program ? { program } : {}),
  });
  restoreExportedMemory(instance, memory, init);
  main.memory = memoryOf(instance, memory);
  publishMemory(init.sab, sizeOf(main)());
  signals.bind(instance.exports);
  host.onRaise = (sig) => signals.raised(sig);
  const exports = instance.exports as { _start: () => void };
  driver.bind(instance.exports);
  try {
    if (fork) driver.startChild(fork);

    do exports._start();
    while (driver.resume());
    return 0;
  } catch (e) {
    if (e instanceof WasiExit) return e.code;
    if (!(e instanceof WebAssembly.RuntimeError)) throw e;
    try {
      say(trapMessage(e, init.env, '', programNames(host, init.program)));
    } catch {
      throw new Error(`${init.argv0}: wasm trap: ${e.message}`);
    }
    return TRAPPED;
  } finally {
    host.flushAll();
    if (stats) report(stats, sys);
  }
}

const BACKTRACE_FRAMES = 40;

export function trapMessage(
  e: WebAssembly.RuntimeError,
  env: Readonly<Record<string, string>>,
  where = '',
  name?: (index: number) => string | undefined
): string {
  const head = `wasm trap${where}: ${e.message}`;
  if (env.SLICC_WASM_BACKTRACE !== '1') return head;
  const lines = (e.stack ?? '').split('\n');

  const main = name && mainModule(lines);

  const frames = lines
    .filter((line) => /^\s+at .*wasm:\/\/wasm\//.test(line))
    .slice(0, BACKTRACE_FRAMES)
    .map((line) => (name && main ? nameFrame(line, main, name) : line));
  return frames.length ? `${head}\n${frames.join('\n')}` : head;
}

function programNames(
  host: WasiHost,
  program: WasmProgram
): ((index: number) => string | undefined) | undefined {
  const path = program.names;
  return path === undefined ? undefined : sidecarNames((p) => host.o.fs.readFile(p), path);
}

async function programImports(
  program: WasmProgram,
  host: WasiHost,
  transport: { call(req: WasmSyscall, timeoutMs: number, label: string): SyncFsResult },
  tid: number
): Promise<ProgramOption | undefined> {
  if (program.imports === undefined) return undefined;
  const create = await loadImports(program.imports);
  const raw: Raw = (req) => transport.call(req as WasmSyscall, Number.POSITIVE_INFINITY, req.op);
  return (memory, instance) => create(importsContext({ host, raw, tid, memory, instance }));
}

export function captureBacktraces(env: Readonly<Record<string, string>>): void {
  if (env.SLICC_WASM_BACKTRACE !== '1') return;

  const v8 = Error as ErrorConstructor & { stackTraceLimit?: number };
  v8.stackTraceLimit = Math.max(v8.stackTraceLimit ?? 0, BACKTRACE_FRAMES + 20);
}

export async function runWasiThread(init: WasmThreadInitMsg, port: SabPostLike): Promise<void> {
  captureBacktraces(init.env);
  const { transport, sys, call, say } = kernelOf(init, port);
  const { thread } = init;
  const threads = new WasiThreads(port, thread.memory, threadCap(init.env), thread.tid, thread.ids);
  threads.received = thread.modules;
  const host = new WasiHost({
    args: [init.argv0, ...init.args],
    env: init.env,
    cwd: init.cwd,
    pid: init.pid,
    ...(init.ppid !== undefined ? { ppid: init.ppid } : {}),
    kernel: { sys, call },
    fs: cachingBridge(createSyncFsSabBridge(transport)),
    shared: threads.ids,
  });

  const program = await programImports(init.program, host, transport, thread.tid);
  const { instance } = await instantiate(host, init.program.module, thread.memory, threads, {
    thread: true,
    foreign: init.program.foreign,
    ...(program ? { program } : {}),
  });
  const start = instance.exports.wasi_thread_start as (tid: number, arg: number) => void;
  try {
    start(thread.tid, thread.arg);
    threads.exited();
  } catch (e) {
    if (e instanceof ThreadExit) {
      threads.exited();
      return;
    }
    if (e instanceof WasiExit) {
      port.postMessage({ type: WASM_PROCESS_EXIT, code: e.code });
      return;
    }
    if (e instanceof WebAssembly.RuntimeError) {
      try {
        say(trapMessage(e, init.env, ` in thread ${thread.tid}`, programNames(host, init.program)));
      } catch {}
      port.postMessage({ type: WASM_PROCESS_EXIT, code: TRAPPED });
      return;
    }
    throw e;
  }
}
