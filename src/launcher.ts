import { type Command, scanCommands } from './commands.ts';
import { followLinks, withCommandDirs } from './fs/commands.ts';
import type { KernelFs } from './fs/types.ts';
import {
  type ChildForker,
  type ChildHandle,
  type ChildSpawner,
  SpawnError,
} from './kernel/children.ts';
import { bytesSource, FdTable, nullFile, sinkFile } from './kernel/fd-table.ts';
import { spawnWasmProcess, type WasmProcessHandle, type WasmWorkerLike } from './kernel/host.ts';
import { JobTable } from './kernel/jobs.ts';
import { HttpHandles } from './kernel/net/http-syscalls.ts';
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
import type { RealmTransport } from './kernel/net/transport.ts';
import type { ForkState, WasmProgram } from './kernel/protocol.ts';
import { PtyTable } from './kernel/pty.ts';
import { LoopbackNet } from './kernel/socket.ts';
import { KernelTty } from './kernel/tty.ts';

export interface LauncherOptions {
  fs: KernelFs;
  createWorker: () => WasmWorkerLike;
  modules?: string;
  env?: Record<string, string>;
  transport?: RealmTransport;
  caStore?: CaStore;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
  onStdout?: (bytes: Uint8Array) => void;
  onStderr?: (bytes: Uint8Array) => void;
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
  glue: string;
  wasm: string;
  argv0: string;
  prefix?: string[];
  env?: Record<string, string>;
}

interface Planned {
  target: Target;
  args: string[];
}

interface StartRequest {
  program: WasmProgram;
  argv0: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  fds: FdTable;
  report: (message: string) => void;
  ppid?: number;
  fork?: ForkState;
}

const COMMAND = /^\/(?:usr\/)?bin\/([^/]+)$/;
const SHEBANG_MAX = 256;
const NOT_FOUND = 127;
const SHARED_DIRS = ['/tmp', '/home'];
const encoder = new TextEncoder();

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function modulePath(glue: string): string {
  return glue.endsWith('.js') ? `${glue.slice(0, -3)}.wasm` : `${glue}.wasm`;
}

function targetOf(command: Command): Target {
  return {
    glue: command.glue,
    wasm: command.wasm,
    argv0: command.argv0,
    ...(command.args ? { prefix: command.args } : {}),
    ...(command.env ? { env: command.env } : {}),
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
  private readonly compiled = new Map<string, Promise<WebAssembly.Module>>();
  private readonly processes = new Map<number, WasmProcessHandle>();
  private readonly zombies = new Set<number>();
  private readonly orphans = new Set<number>();
  private readonly jobs = new JobTable();
  private readonly ptys = new PtyTable((tty, sig) => this.jobs.signalOwnedForeground(tty, sig));
  readonly net = new LoopbackNet();
  private readonly ca: () => Promise<RealmCa>;
  private readonly transport: RealmTransport;
  private nextPid = 1000;
  private terminals = 0;

  constructor(options: LauncherOptions) {
    this.base = options.fs;
    this.createWorker = options.createWorker;
    this.modulesDir = options.modules ?? '/node_modules';
    this.env = { ...networkEnv(), ...options.env };
    this.ca = kernelCa(options.caStore ?? memoryCaStore());
    this.transport = options.transport ?? missingTransport();
    enableNetwork(this.net, {
      transport: this.transport,
      engine: kernelTlsEngine(packageTlsEngine(options.fs, this.modulesDir)),
      ca: this.ca,
    });
    this.fs = withCommandDirs(options.fs, async () => new Set((await this.commands()).keys()));
  }

  commands(): Promise<Map<string, Command>> {
    this.catalog ??= scanCommands(this.base, this.modulesDir);
    return this.catalog;
  }

  async resolve(file: string, argv0: string, cwd: string): Promise<Target | undefined> {
    const name = COMMAND.exec(file)?.[1] ?? (file.includes('/') ? undefined : file);
    if (name !== undefined) {
      const command = (await this.commands()).get(name);
      return command && targetOf(command);
    }
    const glue = await followLinks(this.base, this.fs.resolvePath(cwd, file));
    const linked = COMMAND.exec(glue)?.[1];
    if (linked !== undefined) return this.resolve(`/bin/${linked}`, argv0, cwd);
    const wasm = modulePath(glue);
    if (!(await this.base.exists(glue)) || !(await this.base.exists(wasm))) return undefined;
    return { glue, wasm, argv0: baseName(argv0 || file) };
  }

  private async interpreted(
    file: string,
    argv: string[],
    cwd: string
  ): Promise<Planned | undefined> {
    let head: Uint8Array;
    try {
      head = (await this.base.readFileBuffer(this.fs.resolvePath(cwd, file))).subarray(
        0,
        SHEBANG_MAX
      );
    } catch {
      return undefined;
    }
    if (head[0] !== 0x23 || head[1] !== 0x21) return undefined;
    const words = new TextDecoder()
      .decode(head)
      .slice(2)
      .split('\n')[0]
      .trim()
      .split(/[ \t]+/);
    if (baseName(words[0]) === 'env') words.shift();
    const [interp, ...rest] = words;
    const target = interp ? await this.resolve(interp, interp, cwd) : undefined;
    if (!target) return undefined;
    const arg = rest.join(' ');
    return {
      target,
      args: [...(target.prefix ?? []), ...(arg ? [arg] : []), file, ...argv.slice(1)],
    };
  }

  private async plan(file: string, argv: string[], cwd: string): Promise<Planned | undefined> {
    const direct = await this.resolve(file, argv[0] ?? file, cwd);
    if (direct) return { target: direct, args: [...(direct.prefix ?? []), ...argv.slice(1)] };
    return this.interpreted(file, argv, cwd);
  }

  private async unrunnable(file: string, cwd: string): Promise<'ENOEXEC' | 'ENOENT'> {
    const head = await this.base.readFileBuffer(this.fs.resolvePath(cwd, file)).catch(() => null);
    return head && !(head[0] === 0x23 && head[1] === 0x21) ? 'ENOEXEC' : 'ENOENT';
  }

  private module(path: string): Promise<WebAssembly.Module> {
    return this.base.stat(path).then((st) => {
      const key = `${path}:${st.size}:${st.mtime.getTime()}`;
      let module = this.compiled.get(key);
      if (!module) {
        module = this.base
          .readFileBuffer(path)
          .then((bytes) => WebAssembly.compile(bytes as BufferSource));
        this.compiled.set(key, module);
        module.catch(() => this.compiled.delete(key));
      }
      return module;
    });
  }

  private async launch(
    planned: Planned,
    req: Omit<StartRequest, 'program' | 'argv0' | 'args'>
  ): Promise<WasmProcessHandle> {
    const { target, args } = planned;
    let program: WasmProgram;
    try {
      const [glue, module] = await Promise.all([
        this.base.readFile(target.glue),
        this.module(target.wasm),
      ]);
      program = { glue, module };
    } catch (err) {
      await req.fds.closeAll();
      throw err;
    }
    return this.start({
      ...req,
      program,
      argv0: target.argv0,
      args,
      env: { ...target.env, ...req.env },
    });
  }

  private start(req: StartRequest): WasmProcessHandle {
    const pid = this.nextPid++;
    const terminal = req.fds.stdioTerminal();
    const handle = spawnWasmProcess({
      pid,
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
      jobs: this.jobs,
      ptys: this.ptys,
      net: this.net,
      http: new HttpHandles(this.transport),
      onReap: (child) => this.reaped(child),
      ...(req.fork ? { fork: req.fork } : {}),
      ...(req.ppid !== undefined ? { ppid: req.ppid } : {}),
    });
    this.processes.set(pid, handle);
    this.jobs.add(pid, req.ppid, (sig) => handle.signal(sig), terminal);
    void handle.exited.then(() => {
      this.processes.delete(pid);
      if (req.ppid === undefined || this.orphans.delete(pid)) this.jobs.remove(pid);
      else this.zombies.add(pid);
    });
    return handle;
  }

  private reaped(pid: number): void {
    if (this.zombies.delete(pid)) this.jobs.remove(pid);
    else this.orphans.add(pid);
  }

  private spawner(ppid: number, report: (message: string) => void): ChildSpawner {
    return async (req, fds) => {
      const planned = await this.plan(req.file, req.argv, req.cwd);
      if (!planned) {
        await fds.closeAll();
        throw new SpawnError(await this.unrunnable(req.file, req.cwd));
      }
      const handle = await this.launch(planned, { env: req.env, cwd: req.cwd, fds, report, ppid });
      return childHandle(handle);
    };
  }

  private forker(ppid: number, parent: StartRequest): ChildForker {
    return async (state, fds) =>
      childHandle(this.start({ ...parent, cwd: state.cwd ?? parent.cwd, fds, ppid, fork: state }));
  }

  kill(pid: number, sig: number): boolean {
    if (pid < 0) return this.jobs.killGroup(-pid, sig);
    const handle = this.processes.get(pid);
    if (!handle) return false;
    if (sig !== 0) handle.signal(sig);
    return true;
  }

  async prepare(): Promise<void> {
    for (const dir of SHARED_DIRS) await this.base.mkdir(dir, { recursive: true });
    await writeCaFile(this.base, this.ca).catch(() => undefined);
  }

  private environment(cwd: string, extra: Record<string, string> | undefined) {
    return { PATH: '/usr/bin:/bin', HOME: '/home', ...this.env, PWD: cwd, ...extra };
  }

  private async starting(argv: string[], dir: string | undefined) {
    this.catalog = undefined;
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
      (sig) => this.jobs.signalForeground(tty, leader, sig)
    );
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
    const collect =
      (chunks: Uint8Array[], tee?: (bytes: Uint8Array) => void) => (bytes: Uint8Array) => {
        chunks.push(bytes);
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
    fds.installAt(0, options.stdin ? bytesSource(options.stdin) : nullFile());
    fds.installAt(1, sinkFile(stdout));
    fds.installAt(2, sinkFile(stderr));
    const handle = await this.launch(planned, { env, cwd, fds, report });
    const status = await handle.exited;
    return { status, stdout: concat(out), stderr: concat(err) };
  }
}
