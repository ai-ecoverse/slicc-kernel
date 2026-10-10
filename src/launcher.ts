import { enableCdp } from './cdp/facade.ts';
import { CdpHosts } from './cdp/hosts.ts';
import type { CdpHook } from './cdp/types.ts';
import { serveClient } from './client/serve-client.ts';
import {
  type Abi,
  binfmtOf,
  type Command,
  pnpmGlobalRoots,
  scanBinfmts,
  scanCommands,
  scanFilesystems,
} from './commands.ts';

export const PNPM_HOME = '/home/.local/share/pnpm';

import { followLinks, withCommandDirs } from './fs/commands.ts';
import type { KernelFs } from './fs/types.ts';
import { fsError, normalizePath } from './fs/types.ts';
import { FsWatchers } from './fs/watch.ts';
import {
  type ChildForker,
  type ChildHandle,
  type ChildSpawner,
  SpawnError,
} from './kernel/children.ts';
import { bytesSource, deviceFile, FdTable, sinkFile } from './kernel/fd-table.ts';
import { spawnWasmProcess, type WasmProcessHandle, type WasmWorkerLike } from './kernel/host.ts';
import { LockTable } from './kernel/host-ops.ts';
import { type JobMember, JobTable } from './kernel/jobs.ts';
import { HttpHandles } from './kernel/net/http-syscalls.ts';
import { DEFAULT_HOSTNAME, isHostname } from './kernel/net/loopback-names.ts';
import {
  enableNetwork,
  kernelCa,
  kernelTlsEngine,
  memoryCaStore,
  missingTransport,
  networkEnv,
  packageTlsEngine,
  writeCaFile,
} from './kernel/net/network.ts';
import type { CaStore, RealmCa } from './kernel/net/realm-ca.ts';
import { Resolver } from './kernel/net/resolver.ts';
import { Routes, type RouteTable } from './kernel/net/routes.ts';
import type { RealmTransport } from './kernel/net/transport.ts';
import type { NetworkUplink } from './kernel/net/uplink.ts';
import type { ProcessInfo } from './kernel/proc-info.ts';
import { DEFAULT_UMASK } from './kernel/process.ts';
import type { ForkState, Program } from './kernel/protocol.ts';
import { PtyTable } from './kernel/pty.ts';
import { SettlingChildren } from './kernel/settling.ts';
import { LoopbackNet } from './kernel/socket.ts';
import { KernelTty } from './kernel/tty.ts';
import { keepingOpen, VfsNodes } from './kernel/vfs-file.ts';
import { type ServedFilesystem, serveFilesystem } from './mount/driver.ts';
import {
  FSA_CAPABILITIES,
  granted,
  type Medium,
  type MediumHandle,
  removableMedium,
} from './mount/fsa.ts';
import {
  FSTAB_PATH,
  FSTAB_RETRIES,
  type FstabResult,
  mountFstab,
  parseFstab,
} from './mount/fstab.ts';
import {
  type FetchLike,
  type HostfsGrantHook,
  type HostfsTiming,
  openHostfs,
} from './mount/hostfs.ts';
import { type MediaStore, memoryMedia } from './mount/media.ts';
import {
  HeldSet,
  heldUnder,
  type MountEntry,
  type MountSpec,
  MountTable,
  type OpenedDriver,
} from './mount/mount-fs.ts';
import {
  type MountCall,
  mountCall,
  type ProcessMountPolicy,
  type ProcessMountRequest,
  umountCall,
} from './mount/syscall.ts';
import { tmpfs } from './mount/tmpfs.ts';
import {
  type ForeignResults,
  foreignImports,
  type ImportedMemory,
  importedMemory,
} from './process/wasi/wasi-module.ts';

export interface LauncherOptions {
  fs: KernelFs;
  createWorker: () => WasmWorkerLike;
  modules?: string;
  env?: Record<string, string>;
  transport?: RealmTransport;
  caStore?: CaStore;
  createDriverWorker?: () => WasmWorkerLike;
  media?: MediaStore;
  onMountPending?: (pending: PendingMedium) => void;
  hostfs?: HostfsGrantHook;
  hostfsFetch?: FetchLike;
  hostfsTiming?: HostfsTiming;
  processMounts?: ProcessMountPolicy;
  fstabRetries?: readonly number[];
  cdp?: CdpHook;
  uplink?: NetworkUplink;
  hostname?: string;
}

export interface PendingMedium {
  target: string;
  source: string;
  handle?: MediumHandle;
}

interface Removable {
  id: string;
  medium: Medium;
  served: ServedFilesystem;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
  onStdout?: (bytes: Uint8Array) => void;
  onStderr?: (bytes: Uint8Array) => void;
  onStarted?: (pid: number) => void;
  collect?: boolean;
  pgid?: number;
}

export interface TerminalOptions {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  onData: (bytes: Uint8Array) => void;
}

export interface TerminalSession {
  pid: number;
  exited: Promise<number>;
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  signal(sig: number): void;
  close(): void;
}

export interface RunResult {
  status: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

interface Target {
  abi: Abi;
  glue: string;
  wasm: string;
  argv0: string;
  prefix?: string[];
  env?: Record<string, string>;
  unset?: string[];
  imports?: string;
  preopenRoot?: boolean;
}

interface Compiled {
  module: WebAssembly.Module;
  memory?: ImportedMemory;
  foreign?: ForeignResults | undefined;
}

interface Planned {
  target: Target;
  args: string[];
}

interface StartRequest {
  program: Program;
  argv0: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  fds: FdTable;
  report: (message: string) => void;
  ppid?: number;
  fork?: ForkState;
  exec?: boolean;
  pgid?: number;
  ignored?: number;
  umask?: number;
  decided?: Promise<boolean>;
}

const COMMAND = /^\/(?:usr\/)?bin\/([^/]+)$/;
const PACKAGE_ROOT = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const SHEBANG_MAX = 256;
const MAX_INTERPRETERS = 4;
const NOT_FOUND = 127;
const DECIDE_MS = 100;
const INIT_PID = 1;
const SHARED_DIRS = ['/tmp', '/home'];
const encoder = new TextEncoder();

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function modulePath(glue: string): string {
  return glue.endsWith('.js') ? `${glue.slice(0, -3)}.wasm` : `${glue}.wasm`;
}

function isWasm(bytes: Uint8Array): boolean {
  return WASM_MAGIC.every((b, i) => bytes[i] === b);
}

function shebang(head: Uint8Array): string[] | undefined {
  if (head[0] !== 0x23 || head[1] !== 0x21) return undefined;
  return new TextDecoder()
    .decode(head.subarray(0, SHEBANG_MAX))
    .slice(2)
    .split('\n')[0]
    .trim()
    .split(/[ \t]+/);
}

function interpreter(head: Uint8Array): string {
  const words = shebang(head);
  if (!words) return 'node';
  if (baseName(words[0]) === 'env') words.shift();
  if (words[0] === '-S') words.shift();
  return baseName(words[0] ?? '');
}

export function expandDefaults(
  defaults: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string>>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaults ?? {})) {
    let missing = false;
    const expanded = value.replace(ENV_REFERENCE, (_, name: string) => {
      const set = Object.hasOwn(env, name) ? env[name] : undefined;
      if (set === undefined) missing = true;
      return set ?? '';
    });
    if (!missing) out[key] = expanded;
  }
  return out;
}

function targetOf(command: Command): Target {
  return {
    abi: command.abi,
    glue: command.glue,
    wasm: command.wasm,
    argv0: command.argv0,
    ...(command.args ? { prefix: command.args } : {}),
    ...(command.env ? { env: command.env } : {}),
    ...(command.unset ? { unset: command.unset } : {}),
    ...(command.imports ? { imports: command.imports } : {}),
    ...(command.preopenRoot ? { preopenRoot: true } : {}),
  };
}

function withScriptEnv(target: Target, command: Command | undefined): Target {
  if (!command) return target;
  return {
    ...target,
    env: { ...target.env, ...command.env },
    unset: [
      ...(target.unset ?? []).filter((key) => !Object.hasOwn(command.env ?? {}, key)),
      ...(command.unset ?? []),
    ],
  };
}

function childHandle(handle: WasmProcessHandle): ChildHandle {
  return {
    pid: handle.pid,
    exited: handle.exited,
    termsig: handle.termsig,
    onState: (listener) => handle.onState(listener),
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export class Launcher {
  readonly fs: KernelFs;
  private readonly base: KernelFs;
  private readonly createWorker: () => WasmWorkerLike;
  private readonly modulesDir: string;
  private readonly env: Record<string, string>;
  private catalog: Promise<Map<string, Command>> | undefined;
  private binfmts: Promise<Map<string, string>> | undefined;
  private readonly compiled = new Map<string, Promise<Compiled>>();
  private readonly processes = new Map<number, WasmProcessHandle>();
  private readonly zombies = new Set<number>();
  private readonly orphans = new Set<number>();
  private readonly described = new Map<number, Pick<ProcessInfo, 'argv' | 'tty' | 'started'>>();
  private readonly jobs = new JobTable();
  private readonly locks = new LockTable();
  private readonly settling = new SettlingChildren((pid) => this.jobs.pgidOf(pid));
  private readonly ptys = new PtyTable(
    (tty, sig) => this.keySignal(tty, 0, sig, () => this.jobs.signalOwnedForeground(tty, sig)),
    (tty) => this.settling.reading(this.jobs.tcgetpgrp(tty, 0))
  );
  readonly net = new LoopbackNet();
  readonly cdp: CdpHosts;
  private readonly ca: () => Promise<RealmCa>;
  readonly transport: RealmTransport;
  readonly uplink: NetworkUplink | undefined;
  readonly routes: Routes;
  readonly resolver: Resolver;
  readonly hostname: string;
  readonly watchers = new FsWatchers();
  private readonly pnpmHome: string;
  readonly mounts: MountTable;
  private readonly createDriverWorker: (() => WasmWorkerLike) | undefined;
  private readonly media: MediaStore;
  private readonly onMountPending: ((pending: PendingMedium) => void) | undefined;
  private readonly removable = new Map<string, Removable>();
  private readonly hostfs: Pick<LauncherOptions, 'hostfs' | 'hostfsFetch' | 'hostfsTiming'>;
  private readonly fstabRetries: readonly number[];
  private readonly inserted = new Map<string, MediumHandle>();
  private readonly openFiles = new Set<VfsNodes>();
  private readonly deciding = new Map<number, Set<(byParent: boolean) => void>>();
  readonly identities = { asked: 0, timedOut: 0 };
  private readonly nodes: VfsNodes;
  private readonly held = new HeldSet((path) => this.released(path));
  private readonly processMounts: ProcessMountPolicy;
  private readonly booting = new AbortController();
  fstab: Promise<FstabResult[]> = Promise.resolve([]);
  private nextPid = 1000;
  readonly boot = Date.now();
  private terminals = 0;

  constructor(options: LauncherOptions) {
    this.mounts = new MountTable({
      open: (type, spec) => this.driver(type, spec),
      busy: (target) =>
        [...this.openFiles].some((nodes) => nodes.holds(target)) || heldUnder(this.held, target),
      changed: this.watchers.changed.bind(this.watchers),
    });
    this.base = this.watchers.wrap(this.mounts.wrap(options.fs));
    this.createWorker = options.createWorker;
    this.createDriverWorker = options.createDriverWorker;
    this.media = options.media ?? memoryMedia();
    this.onMountPending = options.onMountPending;
    this.hostfs = options;
    this.fstabRetries = options.fstabRetries ?? FSTAB_RETRIES;
    this.processMounts = options.processMounts ?? true;
    this.pnpmHome = options.env?.PNPM_HOME ?? PNPM_HOME;
    this.modulesDir = options.modules ?? '/node_modules';
    this.cdp = new CdpHosts(options.cdp);
    const hostname = options.hostname ?? DEFAULT_HOSTNAME;
    if (!isHostname(hostname)) throw new Error(`not a host name: ${String(hostname)}`);
    this.hostname = hostname;
    this.env = { ...networkEnv(hostname), SLICC_CDP_URL: this.cdp.url, ...options.env };
    this.ca = kernelCa(options.caStore ?? memoryCaStore());
    this.transport = options.transport ?? missingTransport();
    this.uplink = options.uplink;
    this.routes = new Routes(options.uplink?.traits.ipv6 === true);
    if (options.uplink?.routes) this.routes.set(options.uplink.routes);
    this.resolver = new Resolver({ uplink: options.uplink, routes: this.routes, hostname });
    if (options.uplink) this.net.useUplink({ uplink: options.uplink, routes: this.routes });
    enableNetwork(this.net, {
      transport: this.transport,
      engine: kernelTlsEngine(packageTlsEngine(options.fs, this.modulesDir)),
      ca: this.ca,
    });
    enableCdp(this.net, this.cdp);
    const fs = withCommandDirs(this.base, async () => new Set((await this.commands()).keys()));
    this.nodes = new VfsNodes(fs, (path) => this.released(path));
    this.openFiles.add(this.nodes);
    this.fs = keepingOpen(fs, this.nodes);
    this.watchers.watch([this.modulesDir, this.pnpmHome], { recursive: true }, () => {
      this.catalog = undefined;
      this.binfmts = undefined;
    });
  }

  setRoutes(table: RouteTable): void {
    this.routes.set(table);
  }

  commands(): Promise<Map<string, Command>> {
    this.catalog ??= this.roots().then((roots) => scanCommands(this.base, roots));
    return this.catalog;
  }

  private interpreters(): Promise<Map<string, string>> {
    this.binfmts ??= this.roots().then((roots) => scanBinfmts(this.base, roots));
    return this.binfmts;
  }

  private async roots(): Promise<string[]> {
    return [this.modulesDir, ...(await pnpmGlobalRoots(this.base, this.pnpmHome))];
  }

  async resolve(file: string, argv0: string, cwd: string): Promise<Target | undefined> {
    const name = COMMAND.exec(file)?.[1] ?? (file.includes('/') ? undefined : file);
    if (name !== undefined) {
      const command = (await this.commands()).get(name);
      return command && !command.script ? targetOf(command) : undefined;
    }
    const path = this.fs.resolvePath(cwd, file);
    const glue = await followLinks(this.base, path);
    const linked = COMMAND.exec(glue)?.[1];
    if (linked !== undefined) {
      const target = await this.resolve(`/bin/${linked}`, argv0, cwd);
      const byPath = !COMMAND.test(path) && (await this.commands()).get(linked)?.argv0Path === true;
      return target && byPath ? { ...target, argv0: path } : target;
    }
    const head = await this.head(glue);
    if (!head) return undefined;
    if (isWasm(head)) {
      return {
        abi: 'wasi',
        glue,
        wasm: glue,
        argv0: baseName(argv0 || file).replace(/\.wasm$/, ''),
      };
    }
    if (interpreter(head) !== 'node') return undefined;
    const wasm = modulePath(glue);
    if (!(await this.base.exists(wasm))) return undefined;
    return { abi: 'emscripten', glue, wasm, argv0: baseName(argv0 || file) };
  }

  private async head(path: string): Promise<Uint8Array | undefined> {
    try {
      return (await this.base.readFileBuffer(path)).subarray(0, SHEBANG_MAX);
    } catch {
      return undefined;
    }
  }

  private async scriptCommand(file: string): Promise<Command | undefined> {
    const name = COMMAND.exec(file)?.[1] ?? (file.includes('/') ? undefined : file);
    if (name === undefined) return undefined;
    const command = (await this.commands()).get(name);
    return command?.script ? command : undefined;
  }

  private async interpreted(
    file: string,
    argv: string[],
    cwd: string,
    depth = 0
  ): Promise<Planned | undefined> {
    const command = await this.scriptCommand(file);
    const script = command?.script ?? this.fs.resolvePath(cwd, file);
    const head = await this.head(script);
    if (!head) return undefined;
    const binfmt = isWasm(head) ? undefined : binfmtOf(await this.interpreters(), script);
    const words = shebang(head) ?? (binfmt ? [binfmt] : undefined);
    if (!words) return undefined;
    if (baseName(words[0]) === 'env') words.shift();
    const [interp, ...rest] = words;
    const arg = rest.join(' ');
    const passed = [...(arg ? [arg] : []), command ? script : file, ...argv.slice(1)];
    const found = interp ? await this.resolve(interp, interp, cwd) : undefined;
    if (!found) {
      if (!interp || depth >= MAX_INTERPRETERS || !(await this.scriptCommand(interp))) {
        return undefined;
      }
      const inner = await this.interpreted(interp, [interp, ...passed], cwd, depth + 1);
      return inner && { ...inner, target: withScriptEnv(inner.target, command) };
    }
    const target = withScriptEnv(found, command);
    return { target, args: [...(target.prefix ?? []), ...passed] };
  }

  private async plan(file: string, argv: string[], cwd: string): Promise<Planned | undefined> {
    const direct = await this.resolve(file, argv[0] ?? file, cwd);
    if (direct) return { target: direct, args: [...(direct.prefix ?? []), ...argv.slice(1)] };
    return this.interpreted(file, argv, cwd);
  }

  private async unrunnable(file: string, cwd: string): Promise<'ENOEXEC' | 'ENOENT'> {
    const path = this.fs.resolvePath(cwd, file);
    const head = await this.base.readFileBuffer(path).catch(() => null);
    if (!head || (head[0] === 0x23 && head[1] === 0x21)) return 'ENOENT';
    return binfmtOf(await this.interpreters(), path) ? 'ENOENT' : 'ENOEXEC';
  }

  private module(path: string): Promise<Compiled> {
    return this.base.stat(path).then((st) => {
      const key = `${path}:${st.size}:${st.mtime.getTime()}`;
      let module = this.compiled.get(key);
      if (!module) {
        module = this.base.readFileBuffer(path).then(async (bytes) => {
          const memory = importedMemory(bytes);
          const foreign = foreignImports(bytes);
          const compiled = await WebAssembly.compile(bytes as BufferSource);
          return {
            module: compiled,
            ...(memory ? { memory } : {}),
            foreign,
          };
        });
        this.compiled.set(key, module);
        module.catch(() => this.compiled.delete(key));
      }
      return module;
    });
  }

  private async names(path: string, module: WebAssembly.Module): Promise<string | undefined> {
    if (WebAssembly.Module.customSections(module, 'name').length > 0) return undefined;
    const beside = `${path}.names`;
    if (await this.base.exists(beside)) return beside;
    const root = PACKAGE_ROOT.exec(path)?.[1];
    if (root === undefined) return undefined;
    const optional = `${root}-names${beside.slice(root.length)}`;
    return (await this.base.exists(optional)) ? optional : undefined;
  }

  private async program(target: Target, env: Record<string, string>): Promise<Program> {
    if (target.abi === 'js') {
      return { abi: 'js', glue: await this.base.readFile(target.wasm), path: target.wasm };
    }
    if (target.abi !== 'wasi') {
      const [glue, { module }] = await Promise.all([
        this.base.readFile(target.glue),
        this.module(target.wasm),
      ]);
      return { glue, module };
    }
    const { module, memory, foreign } = await this.module(target.wasm);
    const names =
      env.SLICC_WASM_BACKTRACE === '1' ? await this.names(target.wasm, module) : undefined;
    const imports = target.imports ? await this.base.readFile(target.imports) : undefined;
    return {
      abi: 'wasi',
      glue: '',
      module,
      ...(memory ? { memory } : {}),
      foreign,
      ...(names ? { names } : {}),
      ...(imports !== undefined ? { imports } : {}),
      ...(target.preopenRoot ? { preopenRoot: true } : {}),
    };
  }

  private async launch(
    planned: Planned,
    req: Omit<StartRequest, 'program' | 'argv0' | 'args'>
  ): Promise<WasmProcessHandle> {
    const { target, args } = planned;
    const seen = { ...req.env, HOSTNAME: this.hostname, cwd: req.cwd };
    const env = { ...expandDefaults(target.env, seen), ...req.env };
    for (const key of target.unset ?? []) delete env[key];
    env.HOSTNAME = this.hostname;
    let program: Program;
    try {
      program = await this.program(target, env);
    } catch (err) {
      await req.fds.closeAll();
      throw err;
    }
    return this.start({ ...req, program, argv0: target.argv0, args, env });
  }

  groupSession(pgid: number): number | undefined {
    return this.jobs.sessionOf(pgid);
  }

  private start(req: StartRequest): WasmProcessHandle {
    if (req.pgid !== undefined && this.jobs.sessionOf(req.pgid) === undefined) {
      throw fsError('ESRCH', `no process group ${req.pgid}`);
    }
    const pid = this.nextPid++;
    const terminal = req.fds.stdioTerminal();
    const decided = req.decided ?? Promise.resolve(true);
    const count = (byParent: boolean) => {
      this.identities.asked++;
      if (!byParent) this.identities.timedOut++;
    };
    let asked: Promise<void> | undefined;
    const handle = spawnWasmProcess({
      pid,
      identity: async () => {
        await (asked ??= decided.then(count));
        return this.identityOf(pid);
      },
      onSyscall: (call) => {
        this.decide(pid);
        this.settling.syscall(pid, call.op);
      },
      ...(req.ignored ? { ignored: req.ignored } : {}),
      ...(req.umask !== undefined ? { umask: req.umask } : {}),
      program: req.program,
      argv0: req.argv0,
      args: req.args,
      env: req.env,
      cwd: req.cwd,
      fds: req.fds,
      fs: this.fs,
      createWorker: this.createWorker,
      onError: req.report,
      spawner: this.spawner(pid, req.report),
      forker: this.forker(pid, req),
      kill: (target, sig) => this.kill(target, sig),
      writesBack: (target) => this.processes.get(target)?.writesBack() === true,
      processes: () => ({ boot: this.boot, processes: this.list() }),
      openFiles: this.openFiles,
      nodes: this.nodes,
      held: this.held,
      statfs: (path) => this.mounts.statfs(path),
      mounts: () => this.mounts.list(),
      mount: (call, signal) => this.processMount(pid, call, signal),
      umount: (target, flags) => this.processUmount(pid, target, flags),
      jobs: this.jobs,
      ptys: this.ptys,
      net: this.net,
      http: new HttpHandles(this.transport),
      locks: this.locks,
      resolver: this.resolver,
      onReap: (child) => this.reaped(child),
      ...(req.fork ? { fork: req.fork } : {}),
      ...this.shownIds(req),
    });
    this.processes.set(pid, handle);
    if (req.ppid !== undefined) this.settling.started(pid, req.ppid);
    this.jobs.add(pid, req.ppid, (sig) => handle.signal(sig), terminal);
    if (req.exec && req.ppid !== undefined) this.jobs.exec(req.ppid, pid, true);
    if (req.pgid !== undefined) this.jobs.join(pid, req.pgid);
    this.described.set(pid, {
      argv: [req.argv0, ...req.args],
      tty: terminal?.name ?? null,
      started: Date.now(),
    });
    void handle.exited.then(() => {
      this.processes.delete(pid);
      this.settling.settled(pid);
      if (req.ppid === undefined || this.orphans.delete(pid)) this.forget(pid);
      else this.zombies.add(pid);
    });
    return handle;
  }

  private shownIds(req: StartRequest): { ppid?: number; shownPid?: number } {
    if (req.ppid === undefined) return {};
    if (!req.exec) return { ppid: this.jobs.shown(req.ppid) };
    const ppid = this.jobs.shownParent(req.ppid);
    return { shownPid: this.jobs.shown(req.ppid), ...(ppid !== undefined ? { ppid } : {}) };
  }

  private forget(pid: number): void {
    this.jobs.remove(pid);
    this.described.delete(pid);
  }

  private reaped(pid: number): void {
    if (this.zombies.delete(pid)) this.forget(pid);
    else this.orphans.add(pid);
  }

  list(): ProcessInfo[] {
    const members = new Map(this.jobs.list().map((member) => [member.pid, member]));
    const rootOf = (member: JobMember): JobMember => {
      let root = member;
      for (let up = members.get(root.execParent ?? -1); up; up = members.get(up.execParent ?? -1)) {
        root = up;
      }
      return root;
    };
    const shown = (pid: number | undefined): number => {
      const member = pid === undefined ? undefined : members.get(pid);
      const root = member && rootOf(member).pid;
      return root !== undefined && this.running(root) ? root : INIT_PID;
    };
    const listed: ProcessInfo[] = [];
    for (const member of members.values()) {
      const described = this.described.get(member.pid);
      if (member.execed || !described) continue;
      const root = rootOf(member);
      listed.push({
        pid: root.pid,
        tid: member.pid,
        ppid: shown(root.ppid),
        pgid: member.pgid,
        sid: member.sid,
        ...described,
        started: (this.described.get(root.pid) ?? described).started,
        state: this.processes.has(member.pid) ? 'S' : 'Z',
        memory: this.processes.get(member.pid)?.memory() ?? 0,
        umask: this.umaskOf(member.pid),
      });
    }
    return listed;
  }

  private spawner(ppid: number, report: (message: string) => void): ChildSpawner {
    return async (req, fds) => {
      const planned = await this.plan(req.file, req.argv, req.cwd);
      if (!planned) {
        await fds.closeAll();
        throw new SpawnError(await this.unrunnable(req.file, req.cwd));
      }
      const exec = req.exec ? { exec: true } : {};
      const deciding = req.exec ? undefined : this.undecided(ppid);
      const handle = await this.launch(planned, {
        ...(deciding ? { decided: deciding.promise } : {}),
        env: req.env,
        cwd: req.cwd,
        fds,
        report,
        ppid,
        ignored: this.ignoredBy(ppid),
        umask: this.umaskOf(ppid),
        ...exec,
      });
      deciding?.attach();
      return childHandle(handle);
    };
  }

  private undecided(ppid: number) {
    const decided = Promise.withResolvers<boolean>();
    return {
      promise: decided.promise,
      attach: () => {
        const timer = setTimeout(() => decided.resolve(false), DECIDE_MS);
        void decided.promise.then(() => clearTimeout(timer));
        const waiting = this.deciding.get(ppid) ?? new Set();
        waiting.add(decided.resolve);
        this.deciding.set(ppid, waiting);
      },
    };
  }

  private identityOf(pid: number): { pid: number; ppid: number } {
    const parent = this.jobs.shownParent(pid);
    const alive = parent !== undefined && this.running(parent);
    return { pid: this.jobs.shown(pid), ppid: alive ? parent : INIT_PID };
  }

  private running(shown: number): boolean {
    return this.jobs
      .list()
      .some((member) => !this.zombies.has(member.pid) && this.jobs.shown(member.pid) === shown);
  }

  private decide(ppid: number): void {
    const waiting = this.deciding.get(ppid);
    if (!waiting) return;
    this.deciding.delete(ppid);
    setTimeout(() => {
      for (const resolve of waiting) resolve(true);
    }, 0);
  }

  private forker(ppid: number, parent: StartRequest): ChildForker {
    const { exec: _exec, ...image } = parent;
    return async (state, fds) =>
      childHandle(
        this.start({
          ...image,
          cwd: state.cwd ?? parent.cwd,
          fds,
          ppid,
          fork: state,
          ignored: this.ignoredBy(ppid, true),
          umask: this.umaskOf(ppid),
        })
      );
  }

  private keySignal(tty: KernelTty, fallback: number, sig: number, send: () => void): void {
    const pgid = this.jobs.tcgetpgrp(tty, fallback);
    const foreground = () => this.jobs.tcgetpgrp(tty, fallback);
    this.settling.deliver(sig, pgid, send, tty.reading ? undefined : foreground);
  }

  private umaskOf(pid: number): number {
    return this.processes.get(pid)?.umask?.() ?? DEFAULT_UMASK;
  }

  private released(path: string): void {
    const at = normalizePath(path);
    const open = [...this.openFiles].some((nodes) => nodes.writes(at)) || heldUnder(this.held, at);
    if (!open) void this.mounts.commit(at).catch(() => undefined);
  }

  private ignoredBy(pid: number, fork = false): number {
    return this.processes.get(pid)?.ignoredSignals(fork) ?? 0;
  }

  kill(pid: number, sig: number): boolean {
    if (pid < 0) return this.jobs.killGroup(-pid, sig);
    const handle = this.processes.get(pid);
    if (!handle) return false;
    if (sig !== 0) handle.signal(sig);
    return true;
  }

  private async driver(type: string, spec: MountSpec): Promise<OpenedDriver> {
    if (type === 'fsa') return this.fsaDriver(spec);
    if (type === 'hostfs') {
      const { hostfs, hostfsFetch, hostfsTiming } = this.hostfs;
      if (!hostfs)
        throw fsError('ENODEV', 'this kernel has no hostfs hook (createKernel({ hostfs }))');
      return openHostfs(
        spec,
        hostfs,
        hostfsFetch ?? ((url, init) => fetch(url, init)),
        hostfsTiming
      );
    }
    if (type === 'tmpfs') {
      const { port1, port2 } = new MessageChannel();
      serveFilesystem(
        port2,
        tmpfs(),
        { symlinks: true, chmod: true, linkTimes: true, ranges: true, attrTtl: 0 },
        { owned: true }
      );
      return {
        port: port1,
        dispose: () => {
          port1.close();
          port2.close();
        },
      };
    }
    const module = (await scanFilesystems(this.base, await this.roots())).get(type);
    if (!module) throw fsError('ENODEV', `unknown file system type ${type}`);
    if (!this.createDriverWorker)
      throw fsError('ENODEV', `this kernel cannot start ${type} drivers`);
    const code = await this.base.readFile(module);
    const worker = this.createDriverWorker();
    const driver = new MessageChannel();
    const client = new MessageChannel();
    const served = serveClient(client.port1, {
      launcher: async () => this,
      scope: 'transport',
    });
    worker.postMessage({ code, driver: driver.port2, client: client.port2 }, [
      driver.port2,
      client.port2,
    ]);
    return {
      port: driver.port1,
      dispose: () => {
        worker.terminate();
        served.detach();
        driver.port1.close();
      },
      onCrash: (listener) =>
        worker.addEventListener('error', (event) => {
          (event as { preventDefault?: () => void }).preventDefault?.();
          listener(new Error(String((event as { message?: unknown }).message)));
        }),
    };
  }

  private async fsaDriver(spec: MountSpec): Promise<OpenedDriver> {
    const { target, source } = spec;
    const ask = (handle?: MediumHandle) =>
      this.onMountPending?.({ target, source, ...(handle ? { handle } : {}) });
    const { port1, port2 } = new MessageChannel();
    const medium = removableMedium((handle) => {
      served.invalidate(true);
      ask(handle);
    });
    const served = serveFilesystem(port2, medium.handlers, FSA_CAPABILITIES);
    const id = source.slice('fsa:'.length);
    this.removable.set(target, { id, medium, served });
    const stored = this.inserted.get(id) ?? (await this.media.get(id));
    if (stored && (await granted(stored))) medium.insert(stored);
    else ask(stored);
    return {
      port: port1,
      present: () => medium.present(),
      dispose: () => {
        this.removable.delete(target);
        port1.close();
        port2.close();
      },
    };
  }

  mount(spec: MountSpec): Promise<MountEntry> {
    if (spec.type !== 'fsa' || spec.source.startsWith('fsa:'))
      return this.mounts.mount(spec, this.fs);
    return this.mounts.mount({ ...spec, source: `fsa:${crypto.randomUUID()}` }, this.fs);
  }

  async insert(target: string, handle: MediumHandle, source?: string): Promise<void> {
    const at = normalizePath(target);
    const slot = this.removable.get(at);
    if (!slot) throw fsError('EINVAL', `${at} is not a removable mount`);
    if (source !== undefined && source !== `fsa:${slot.id}`) {
      throw fsError('EINVAL', `${at} is no longer the drive ${source}`);
    }
    if (!(await granted(handle))) throw fsError('EACCES', `${at}: no permission for this folder`);
    this.inserted.set(slot.id, handle);
    await this.media.put(slot.id, handle);
    slot.medium.insert(handle);
    slot.served.invalidate(true);
  }

  umount(target: string, detach = false): void {
    const at = normalizePath(target);
    this.mounts.umount(at, detach);
    if (!detach) return;
    for (const nodes of this.openFiles) nodes.revoke(at);
    for (const holds of this.held) holds.revoke(at);
  }

  unmountAll(): void {
    this.booting.abort();
    const targets = this.mounts.list().map((m) => m.target);
    for (const target of targets.sort((a, b) => b.length - a.length)) this.umount(target, true);
  }

  private async permit(req: ProcessMountRequest): Promise<void> {
    const policy = this.processMounts;
    const allowed = typeof policy === 'function' ? await policy(req) : policy;
    if (!allowed) throw fsError('EPERM', `process ${req.pid} may not ${req.op} ${req.target}`);
  }

  private async processMount(pid: number, call: MountCall, signal: AbortSignal): Promise<void> {
    const spec = mountCall(call);
    await this.permit({ op: 'mount', pid, ...spec, options: { ...spec.options } });
    const entry = await this.mount(spec);
    if (signal.aborted) this.umount(entry.target, true);
  }

  private async processUmount(pid: number, target: string, flags: number): Promise<void> {
    const call = umountCall(target, flags);
    for (;;) {
      const mounted = this.mounts.mounted(call.target);
      await this.permit({
        op: 'umount',
        pid,
        target: call.target,
        ...(mounted ? { type: mounted.type, source: mounted.source } : {}),
      });
      if (this.mounts.mounted(call.target) === mounted) break;
    }
    this.umount(call.target, call.detach);
  }

  async prepare(): Promise<void> {
    for (const dir of SHARED_DIRS) await this.base.mkdir(dir, { recursive: true });
    await writeCaFile(this.base, this.ca).catch(() => undefined);
    this.fstab = this.mountFstab();
  }

  private async mountFstab(): Promise<FstabResult[]> {
    const text = await this.base.readFile(FSTAB_PATH).catch(() => '');
    const lines = parseFstab(text);
    for (const { spec } of lines) this.mounts.note(spec, 'pending');
    return mountFstab(
      lines,
      (spec) =>
        this.mount(spec).catch((err: unknown) => {
          this.mounts.note(spec, 'pending', (err as Error)?.message ?? String(err));
          throw err;
        }),
      this.booting.signal,
      this.fstabRetries,
      (entry) => this.umount(entry.target, true),
      ({ spec }, result) => {
        if (!result.code || result.code === 'ECANCELED' || this.booting.signal.aborted) {
          this.mounts.unnote(spec.target);
        } else this.mounts.note(spec, 'failed', result.error);
      }
    );
  }

  private environment(cwd: string, extra: Record<string, string> | undefined) {
    return {
      PATH: `/usr/bin:/bin:${this.pnpmHome}/bin`,
      HOME: '/home',
      PNPM_HOME: this.pnpmHome,
      ...this.env,
      PWD: cwd,
      ...extra,
    };
  }

  private async starting(argv: string[], dir: string | undefined) {
    this.catalog = undefined;
    this.binfmts = undefined;
    const cwd = this.fs.resolvePath('/', dir ?? '/');
    const [file = ''] = argv;
    await this.base.mkdir(cwd, { recursive: true });
    return { cwd, file, planned: await this.plan(file, argv, cwd) };
  }

  async openTerminal(argv: string[], options: TerminalOptions): Promise<TerminalSession> {
    const { cwd, file, planned } = await this.starting(argv, options.cwd);
    if (!planned) throw new Error(`${file}: command not found`);
    let leader = 0;
    const tty: KernelTty = new KernelTty(
      { write: (bytes) => options.onData(bytes.slice()) },
      (sig) => this.keySignal(tty, leader, sig, () => this.jobs.signalForeground(tty, leader, sig))
    );
    tty.onRead = () => this.settling.reading(this.jobs.tcgetpgrp(tty, leader));
    tty.name = `/dev/tty${++this.terminals}`;
    tty.setSize(options.cols ?? 80, options.rows ?? 24);
    const fds = new FdTable();
    const stdio = tty.file();
    fds.installAt(0, stdio);
    fds.installAt(1, stdio.retain());
    fds.installAt(2, stdio.retain());
    const env = this.environment(cwd, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...options.env,
    });
    const report = (message: string) => options.onData(encoder.encode(`${message}\r\n`));
    const handle = await this.launch(planned, { env, cwd, fds, report });
    leader = handle.pid;
    void handle.exited.then(() => tty.hangup());
    return {
      pid: handle.pid,
      exited: handle.exited,
      write: (bytes) => tty.receive(bytes),
      resize: (cols, rows) => tty.resize(cols, rows),
      signal: (sig) => this.jobs.signalForeground(tty, leader, sig),
      close: () => {
        tty.signalHangup();
        tty.hangup();
      },
    };
  }

  async run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
    const { cwd, file, planned } = await this.starting(argv, options.cwd);
    const env = this.environment(cwd, options.env);
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    const keep = options.collect !== false;
    const collect =
      (chunks: Uint8Array[], tee?: (bytes: Uint8Array) => void) => (bytes: Uint8Array) => {
        if (keep) chunks.push(bytes);
        tee?.(bytes);
      };
    const stdout = collect(out, options.onStdout);
    const stderr = collect(err, options.onStderr);
    const report = (message: string) => stderr(encoder.encode(`${message}\n`));
    if (!planned) {
      report(`${file}: command not found`);
      return { status: NOT_FOUND, stdout: concat(out), stderr: concat(err) };
    }
    const fds = new FdTable();
    fds.installAt(0, options.stdin ? bytesSource(options.stdin) : deviceFile('null'));
    fds.installAt(1, sinkFile(stdout));
    fds.installAt(2, sinkFile(stderr));
    const group = options.pgid !== undefined ? { pgid: options.pgid } : {};
    const handle = await this.launch(planned, { env, cwd, fds, report, ...group });
    options.onStarted?.(handle.pid);
    const status = await handle.exited;
    return { status, stdout: concat(out), stderr: concat(err) };
  }
}

export type { ProcessInfo, ProcessListing } from './kernel/proc-info.ts';
