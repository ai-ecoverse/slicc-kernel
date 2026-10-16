import type { Scrubber } from '@ai-ecoverse/slicc-scrub';
import { enableCdp } from './cdp/facade.ts';
import { CdpHosts } from './cdp/hosts.ts';
import type { CdpHook } from './cdp/types.ts';
import { serveClient } from './client/serve-client.ts';
import {
  type Abi,
  binfmtOf,
  binfmtSuffix,
  type Command,
  pnpmGlobalRoots,
  scanBinfmts,
  scanCommands,
  scanFilesystems,
} from './commands.ts';
import { FacadeHosts } from './facade/hosts.ts';
import type { FacadeSpecs } from './facade/types.ts';
import { R_OK, X_OK } from './fs/access.ts';
import { type Attestation, attest, FileWatches, type RemoteFs } from './fs/attest.ts';
import { FileChanges } from './fs/changes.ts';
import { followLinks, withCommandDirs } from './fs/commands.ts';
import { Dac, type DenialHook, type Guard, need, TTY_MODE } from './fs/dac.ts';
import { SHM } from './fs/dev-removal.ts';
import { FreshModules } from './fs/fresh-modules.ts';
import {
  Integrity,
  type IntegrityCaller,
  integrityOptions,
  KERNEL_CALLER,
} from './fs/integrity.ts';
import { chain } from './fs/owners.ts';
import { physicalPathAsync } from './fs/physical-path.ts';
import {
  holdsProtected,
  isProtected,
  ProtectedFs,
  type Protection,
  protectedPrefixes,
  writerTags,
} from './fs/protect.ts';
import type { KernelFs, UsersMode } from './fs/types.ts';
import { fsError, normalizePath } from './fs/types.ts';
import { UNLINKED_DIR, UnlinkedKeeper, type UnlinkOwner, webLocks } from './fs/unlinked.ts';
import { joinName, parentOf, realDir } from './fs/walk.ts';
import { FsWatchers } from './fs/watch.ts';
import {
  type ChildForker,
  type ChildHandle,
  type ChildSpawner,
  type ChildSpawnRequest,
  SpawnError,
} from './kernel/children.ts';
import { ClipboardBroker, type ClipboardHook } from './kernel/clipboard.ts';
import type { CpuTimes } from './kernel/cpu-clock.ts';
import { type Cred, copyCred, maySee, maySignal, ROOT } from './kernel/cred.ts';
import { argvDigest, type Booked, TICKET_ENV } from './kernel/exec-ticket.ts';
import { bytesSource, deviceFile, FdTable, type OpenFile, sinkFile } from './kernel/fd-table.ts';
import { spawnWasmProcess, type WasmProcessHandle, type WasmWorkerLike } from './kernel/host.ts';
import { type JobMember, JobTable } from './kernel/jobs.ts';
import { LockTable } from './kernel/locks.ts';
import { HttpHandles } from './kernel/net/http-syscalls.ts';
import { DEFAULT_HOSTNAME, isHostname } from './kernel/net/loopback-names.ts';
import { KernelLoopback } from './kernel/net/loopback-transport.ts';
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
import { replayingHops } from './kernel/net/redirect-hops.ts';
import { Resolver } from './kernel/net/resolver.ts';
import { Routes, type RouteTable } from './kernel/net/routes.ts';
import type { RealmTransport } from './kernel/net/transport.ts';
import type { NetworkUplink } from './kernel/net/uplink.ts';
import type { ProcessInfo } from './kernel/proc-info.ts';
import { DEFAULT_UMASK } from './kernel/process.ts';
import type { ForkState, Program } from './kernel/protocol.ts';
import { PtyTable } from './kernel/pty.ts';
import { type ScrubSecret, scrubbedAll, scrubberOf, scrubStdio } from './kernel/scrub-file.ts';
import { SealedBroker, type SealedCaller, type SealedHook } from './kernel/sealed.ts';
import { SemTable } from './kernel/sem.ts';
import { SettlingChildren } from './kernel/settling.ts';
import { SIG, sigbit } from './kernel/signals.ts';
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
  grantConnect,
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
import type { SourceCheck } from './realm/sync-fs-token-registry.ts';
import { anyBlocked, type BlockedMask } from './realm/sync-sab-wire.ts';
import { type ApproveHook, Sudo, type SudoCall, type SudoResult } from './sudo.ts';
import { SUDO_COMMAND, SUDO_PATH, SUDO_SOURCE } from './sudo-command.ts';
import {
  type Account,
  credOf,
  GROUP,
  PASSWD,
  pnpmHomeOf,
  SYSTEM_PNPM_HOME,
  UserDb,
  userEnv,
} from './users.ts';

export interface LauncherOptions {
  unlinkOwner?: UnlinkOwner;
  fs: KernelFs;
  createWorker: () => WasmWorkerLike;
  modules?: string;
  commands?: { append?: readonly string[] };
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
  facades?: FacadeSpecs;
  uplink?: NetworkUplink;
  hostname?: string;
  users?: UsersMode;
  onDenial?: DenialHook;
  sealed?: SealedHook;
  clipboard?: ClipboardHook;
  approve?: ApproveHook;
  sudoTimeoutMs?: number;
  protect?: Protection;
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
  user?: string | number | Account;
  tag?: string;
}

export interface TerminalOptions {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  user?: string | number | Account;
  tag?: string;
  onData: (bytes: Uint8Array) => void;
}

export interface TerminalSession {
  pid: number;
  exited: Promise<number>;
  termsig(): number | undefined;
  write(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  signal(sig: number): void;
  close(): void;
}

export interface RunResult {
  status: number;
  signal?: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

interface Target {
  abi: Abi;
  glue: string;
  wasm: string;
  argv0: string;
  fixed?: true;
  prefix?: string[];
  env?: Record<string, string>;
  unset?: string[];
  imports?: string;
  preopenRoot?: boolean;
  asked?: string;
}

interface Compiled {
  module: WebAssembly.Module;
  memory?: ImportedMemory;
  foreign?: ForeignResults | undefined;
}

interface UserScopes {
  byUid: Map<number, string>;
  byBin: Map<string, string>;
}

interface Planned {
  target: Target;
  args: string[];
  script?: true;
  via?: string[];
  sources?: string[];
  bins?: string[];
  asked?: Record<string, string>;
}

interface Redeemer {
  ppid: number;
  cred: Readonly<Cred>;
  scope: string;
  booked: Booked | null | undefined;
}

interface WriterStack {
  fs: KernelFs;
  noLinks: KernelFs;
  nodes: VfsNodes;
  unlinked: UnlinkedKeeper;
  writer: boolean;
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
  group?: 'lead' | 'session';
  ignored?: number;
  blocked?: BlockedMask;
  umask?: number;
  cred: Cred;
  tag?: string | undefined;
  links?: number | undefined;
  decided?: Promise<boolean>;
  pid?: number;
  scrub?: Scrubber;
}

function linksOf(req: StartRequest): { links?: number } {
  return req.links === undefined ? {} : { links: req.links };
}

const COMMAND = /^\/(?:usr\/)?bin\/([^/]+)$/;
const PACKAGE_ROOT = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const SHEBANG_MAX = 256;
const MAX_INTERPRETERS = 4;
const NOT_FOUND = 127;
const NOT_EXECUTABLE = 126;
const DECIDE_MS = 100;
const INIT_PID = 1;
const SHARED_DIRS = ['/tmp', '/home'];

const LAYOUT: ReadonlyArray<[string, number]> = [
  ['/', 0o755],
  ['/root', 0o700],
  ['/home', 0o755],
  ['/etc', 0o755],
  [PASSWD, 0o644],
  [GROUP, 0o644],
  ['/usr', 0o755],
  ['/usr/local', 0o755],
];
const LOAD_SAMPLE_MS = 5000;
const LOAD_WINDOWS_MS = [60_000, 300_000, 900_000] as const;
const encoder = new TextEncoder();

const USERS_MODES: readonly UsersMode[] = ['off', 'report', 'enforce'];

function usersMode(mode: unknown = 'off'): UsersMode {
  if (USERS_MODES.includes(mode as UsersMode)) return mode as UsersMode;
  throw new Error(`users must be 'off', 'report' or 'enforce', not ${String(mode)}`);
}

export function tagOption(tag: unknown): void {
  if (tag !== undefined && typeof tag !== 'string') throw new TypeError('a tag must be a string');
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function packageRootOf(path: string, roots: readonly string[]): string | undefined {
  for (const root of roots) {
    const base = normalizePath(root);
    if (!path.startsWith(`${base}/`)) continue;
    const [first = '', second] = path.slice(base.length + 1).split('/');
    return first.startsWith('@') && second !== undefined
      ? `${base}/${first}/${second}`
      : `${base}/${first}`;
  }
  return undefined;
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

async function rootOnly(fs: KernelFs, path: string, dir = false): Promise<boolean> {
  const names = chain(path);
  for (const [i, at] of names.entries()) {
    const st = await fs.lstat(at).catch(() => undefined);
    const kind = i === names.length - 1 && !dir ? st?.isFile : st?.isDirectory;
    if (!kind || st?.uid !== 0 || (st.mode & 0o022) !== 0) return false;
  }
  return true;
}

function appendedRoots(given: { append?: readonly string[] } | undefined): string[] {
  const roots = given?.append ?? [];
  if (!Array.isArray(roots)) throw new TypeError('commands.append must be an array of paths');
  for (const root of roots) {
    if (typeof root !== 'string' || !root.startsWith('/') || normalizePath(root) !== root) {
      throw new TypeError(`commands.append: not an absolute, normalised path: ${String(root)}`);
    }
  }
  return [...roots];
}

function plainEnv(words: string[]): boolean {
  const next = words[1];
  if (baseName(words[0] ?? '') !== 'env' || next === undefined) return false;
  return next === '-S' || (!next.startsWith('-') && !next.includes('='));
}

function shebangCommand(words: string[]): { interp: string | undefined; args: string[] } {
  if (!plainEnv(words)) {
    const arg = words.slice(1).join(' ');
    return { interp: words[0], args: arg ? [arg] : [] };
  }
  const split = words[1] === '-S';
  const [interp, ...rest] = words.slice(split ? 2 : 1);
  const arg = rest.join(' ');
  return { interp, args: split ? rest : arg ? [arg] : [] };
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
    ...(command.argv0Fixed ? { fixed: true as const } : {}),
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

function addTimes(into: Map<number, CpuTimes>, pid: number, t: CpuTimes): void {
  const at = into.get(pid) ?? { utime: 0, stime: 0 };
  into.set(pid, { utime: at.utime + t.utime, stime: at.stime + t.stime });
}

export class Launcher {
  readonly fs: KernelFs;
  readonly processFs: KernelFs;
  private readonly noLinksFs: KernelFs;
  private readonly mounted: KernelFs;
  private protection: ProtectedFs | undefined;
  private readonly prefixes: string[];
  private readonly writerTags: ReadonlySet<string>;
  private readonly unguardedRoot: KernelFs;
  private writers: WriterStack | undefined;
  private readonly unlinkOwnerOption: UnlinkOwner | undefined;
  private readonly base: KernelFs;
  private readonly createWorker: () => WasmWorkerLike;
  private readonly modulesDir: string;
  private readonly appended: string[];
  private readonly reportedRoots = new Set<string>();
  private readonly env: Record<string, string>;
  private readonly catalogs = new Map<string, Promise<Map<string, Command>>>();
  private readonly ownCatalogs = new Map<string, Promise<ReadonlySet<string>>>();
  private readonly binfmts = new Map<string, Promise<Map<string, string>>>();
  private scopes: Promise<UserScopes> | undefined;
  private unwatchScopes: () => void = () => undefined;
  private readonly warned = new Set<string>();
  private readonly compiled = new Map<string, Promise<Compiled>>();
  private readonly texts = new Map<string, Promise<string>>();
  private revocations = 0;
  private integrity: Integrity | undefined;
  private scannedFs: KernelFs | undefined;

  private get scanned(): KernelFs {
    this.scannedFs ??= this.verifiedFs(this.base);
    return this.scannedFs;
  }
  private readonly processes = new Map<number, WasmProcessHandle>();
  private readonly zombies = new Set<number>();
  private readonly orphans = new Set<number>();
  private readonly described = new Map<number, Pick<ProcessInfo, 'argv' | 'tty' | 'started'>>();
  private readonly creds = new Map<number, () => Cred>();
  private readonly tags = new Map<number, string>();
  private readonly links = new Map<number, number>();
  private readonly freshModules = new FreshModules();
  private readonly granted = new Map<number, number>();
  readonly users: UserDb;
  private readonly sudoer: Sudo;
  private readonly jobs = new JobTable();
  private readonly locks = new LockTable();

  private readonly sems = new SemTable();
  private readonly settling = new SettlingChildren((pid) => this.jobs.pgidOf(pid));
  private readonly ptys = new PtyTable(
    (tty, sig) => this.keySignal(tty, 0, sig, () => this.jobs.signalOwnedForeground(tty, sig)),
    (tty) => this.settling.reading(this.jobs.tcgetpgrp(tty, 0))
  );
  readonly net = new LoopbackNet();
  readonly cdp: CdpHosts;
  readonly facades: FacadeHosts;
  private readonly ca: () => Promise<RealmCa>;
  readonly transport: RealmTransport;
  readonly uplink: NetworkUplink | undefined;
  readonly routes: Routes;
  readonly resolver: Resolver;
  readonly hostname: string;
  readonly watchers = new FsWatchers();
  private readonly changes = new FileChanges();
  private readonly pnpmHome: string;
  private readonly pnpmChain: ReadonlySet<string>;
  private pnpmMade: Promise<void> | undefined;
  private pnpmEpoch = 0;
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
  private readonly unlinked: UnlinkedKeeper;
  private readonly held = new HeldSet((path) => this.released(path));
  private readonly processMounts: ProcessMountPolicy;
  private readonly booting = new AbortController();
  fstab: Promise<FstabResult[]> = Promise.resolve([]);
  readonly usersMode: UsersMode;
  readonly dac: Dac | undefined;
  private readonly sealed: SealedBroker;
  private readonly scrubs = new Map<number, Scrubber[]>();
  private readonly clipboard: ClipboardBroker;
  private readonly rootFs: KernelFs;
  private fileWatches: FileWatches | undefined;
  private nextPid = 1000;
  readonly boot = Date.now();
  private terminals = 0;

  constructor(options: LauncherOptions) {
    this.usersMode = usersMode(options.users);
    this.rootFs = options.fs;
    this.dac = this.usersMode === 'off' ? undefined : new Dac(this.usersMode, options.onDenial);
    if (this.dac) this.dac.tagOf = (pid) => this.tagOf(pid);
    this.clipboard = new ClipboardBroker(options.clipboard, this.usersMode, undefined, (pid) =>
      this.tagOf(pid)
    );
    this.sealed = new SealedBroker(options.sealed, this.usersMode, undefined, (pid) =>
      this.tagOf(pid)
    );
    this.sealed.tickets.normalise = (path) => physicalPathAsync(this.base, path);
    this.sealed.userOf = async (uid) => (await this.users.lookup(uid))?.name;
    if (this.owners) options.fs.trackOwners?.();
    this.watchers.tap((paths) => this.changes.publish(...paths));
    this.watchers.onReshape(() => {
      for (const nodes of this.openFiles) nodes.reshaped();
    });
    this.mounts = new MountTable({
      open: (type, spec) => this.driver(type, spec),
      busy: (target) =>
        [...this.openFiles].some((nodes) => nodes.holds(target)) || heldUnder(this.held, target),
      changed: (...paths) => {
        if (paths.some((path) => this.pnpmChain.has(path))) this.pnpmStale();
        this.watchers.changed(...paths);
      },
      reshaped: () => this.watchers.reshaped(),
      owners: this.owners,
    });
    this.mounted = this.mounts.wrap(options.fs);
    this.base = this.rooted(this.mounted);
    this.createWorker = options.createWorker;
    this.createDriverWorker = options.createDriverWorker;
    this.media = options.media ?? memoryMedia();
    this.onMountPending = options.onMountPending;
    this.hostfs = options;
    this.fstabRetries = options.fstabRetries ?? FSTAB_RETRIES;
    this.processMounts = options.processMounts ?? true;
    this.pnpmHome = options.env?.PNPM_HOME ?? SYSTEM_PNPM_HOME;
    this.pnpmChain = new Set(chain(normalizePath(this.pnpmHome)));
    this.modulesDir = options.modules ?? '/node_modules';
    this.appended = appendedRoots(options.commands);
    this.cdp = new CdpHosts(options.cdp);
    this.facades = new FacadeHosts(options.facades);
    const hostname = options.hostname ?? DEFAULT_HOSTNAME;
    if (!isHostname(hostname)) throw new Error(`not a host name: ${String(hostname)}`);
    this.hostname = hostname;
    this.env = {
      ...networkEnv(hostname),
      SLICC_CDP_URL: this.cdp.url,
      ...this.facades.env(),
      ...options.env,
    };
    this.ca = kernelCa(options.caStore ?? memoryCaStore());
    this.transport = replayingHops(options.transport ?? missingTransport());
    this.announcedTraits = JSON.stringify(this.transport.traits);
    this.uplink = options.uplink;
    this.routes = new Routes(options.uplink?.traits.ipv6 === true);
    if (options.uplink?.routes) this.routes.set(options.uplink.routes);
    this.resolver = new Resolver({ uplink: options.uplink, routes: this.routes, hostname });
    if (options.uplink) this.net.useUplink({ uplink: options.uplink, routes: this.routes });
    enableNetwork(this.net, {
      transport: this.transport,
      engine: kernelTlsEngine(packageTlsEngine(this.verifiedFs(options.fs), this.modulesDir)),
      ca: this.ca,
    });
    enableCdp(this.net, this.cdp);
    this.facades.enable(this.net);
    const fs = this.commandFs(this.base);
    this.nodes = new VfsNodes(fs, (path) => this.released(path));
    this.nodes.keepsOnDisk = true;
    this.openFiles.add(this.nodes);
    const holders = [this.held, this.openFiles];
    this.unlinked = new UnlinkedKeeper(
      fs,
      { [Symbol.iterator]: () => holders.flatMap((set) => [...set]).values() },
      (path) => this.mountRoot(path),
      {
        locks: webLocks(),
        busy: (path) => [...this.openFiles].some((nodes) => nodes.holds(path)),
        owner: options.unlinkOwner,
        ...(this.owners ? { dirOwner: { uid: 0, gid: 0, mode: 0o700 } } : {}),
      }
    );
    this.fs = this.processChain(fs, this.nodes, this.unlinked);
    this.writerTags = writerTags(options.protect);
    this.unlinkOwnerOption = options.unlinkOwner;
    if (this.writerTags.size > 0 && options.fs.protect && !options.fs.unguarded) {
      throw new TypeError('protect.writers needs a root file system with an unguarded view');
    }
    if (!options.fs.noLinks) throw new TypeError('the root file system needs a noLinks view');
    this.unguardedRoot = options.fs.unguarded?.() ?? options.fs;
    this.prefixes = protectedPrefixes(options.protect?.paths ?? []);
    this.protection = this.prefixes.length > 0 ? new ProtectedFs(this.prefixes) : undefined;
    this.processFs = this.protection?.view(this.fs) ?? this.fs;
    const noLinks = this.processChain(
      this.commandFs(this.rooted(this.noLinksOf(this.mounted))),
      this.nodes,
      this.unlinked
    );
    this.noLinksFs = this.protection?.view(noLinks) ?? noLinks;
    const integrity = options.protect?.integrity;
    integrityOptions(integrity);
    options.fs.protect?.(this.prefixes, Boolean(integrity));
    if (integrity && this.prefixes.length > 0) {
      this.integrity = new Integrity(this.prefixes, options.fs, integrity, (event) =>
        options.onDenial?.(event)
      );
    }
    this.users = new UserDb(this.fs, this.owners);
    this.sudoer = new Sudo({
      fs: this.fs,
      users: this.users,
      mode: this.usersMode,
      hostname,
      env: () => this.env,
      pnpmHome: this.pnpmHome,
      backing: (path, cwd) => this.backing(path, cwd),
      approve: options.approve,
      timeoutMs: options.sudoTimeoutMs,
    });
    void this.unlinked.sweep('/');
    this.watchers.watch(
      [this.modulesDir, this.pnpmHome, ...this.appended],
      { recursive: true },
      () => this.resetCatalogs()
    );
    this.watchers.watch([PASSWD], { recursive: false }, () => {
      this.scopes = undefined;
      this.resetCatalogs();
    });
  }

  get owners(): boolean {
    return this.usersMode !== 'off';
  }

  setRoutes(table: RouteTable): void {
    this.routes.set(table);
  }

  private readonly traitsListeners = new Set<() => void>();

  private announcedTraits = '';

  onTraits(listener: () => void): () => void {
    this.traitsListeners.add(listener);
    return () => this.traitsListeners.delete(listener);
  }

  updateTransportTraits(): boolean {
    const now = JSON.stringify(this.transport.traits);
    if (now === this.announcedTraits) return false;
    this.announcedTraits = now;
    for (const listener of [...this.traitsListeners]) listener();
    return true;
  }

  commands(scope = ''): Promise<Map<string, Command>> {
    let found = this.catalogs.get(scope);
    if (!found) {
      found = this.trustedAppended()
        .then(async (appended) => {
          const tiers = await this.tiers(scope, appended);
          return scanCommands(this.scanned, tiers, tiers.length - appended.length);
        })
        .then((commands) => commands.set(SUDO_COMMAND.name, SUDO_COMMAND));
      this.catalogs.set(scope, found);
    }
    return found;
  }

  private ownCommands(scope: string): Promise<ReadonlySet<string>> {
    let found = this.ownCatalogs.get(scope);
    if (!found) {
      found = pnpmGlobalRoots(this.base, scope)
        .then((roots) => scanCommands(this.scanned, roots))
        .then((commands) => new Set(commands.keys()));
      this.ownCatalogs.set(scope, found);
    }
    return found;
  }

  private interpreters(scope = ''): Promise<Map<string, string>> {
    let found = this.binfmts.get(scope);
    if (!found) {
      found = this.roots(scope).then((roots) =>
        scanBinfmts(this.scanned, roots, (message) => {
          if (this.warned.has(message)) return;
          this.warned.add(message);
          console.warn(message);
        })
      );
      this.binfmts.set(scope, found);
    }
    return found;
  }

  private async tiers(scope = '', appended?: readonly string[]): Promise<string[][]> {
    const system = [
      [this.modulesDir],
      await pnpmGlobalRoots(this.base, this.pnpmHome),
      ...(appended ?? (await this.trustedAppended())).map((root) => [root]),
    ];
    return scope ? [await pnpmGlobalRoots(this.base, scope), ...system] : system;
  }

  private async roots(scope = ''): Promise<string[]> {
    return (await this.tiers(scope)).flat();
  }

  private async rootOnlyPath(root: string): Promise<boolean> {
    for (const at of chain(root)) {
      const real = await physicalPathAsync(this.base, at);
      if (!(await rootOnly(this.base, real, true))) return false;
    }
    return true;
  }

  private async trustedAppended(): Promise<string[]> {
    if (this.appended.length === 0 || this.usersMode === 'off') return this.appended;
    const trusted: string[] = [];
    for (const root of this.appended) {
      const real = await physicalPathAsync(this.base, root);
      if (await this.rootOnlyPath(root)) trusted.push(root);
      else if (this.usersMode === 'report' && (await this.base.exists(real))) {
        if (!this.reportedRoots.has(root)) {
          this.reportedRoots.add(root);
          this.dac?.denied({ pid: 0, uid: 0, op: 'commands', path: root, errno: 'EACCES' });
        }
        trusted.push(root);
      }
    }
    return trusted;
  }

  private resetCatalogs(): void {
    this.catalogs.clear();
    this.ownCatalogs.clear();
    this.binfmts.clear();
  }

  private userScopes(): Promise<UserScopes> {
    this.scopes ??= this.users.list().then(
      (accounts) => {
        const users = accounts.filter((account) => account.uid !== 0);
        const homes = users.map((account) => pnpmHomeOf(account, this.pnpmHome));
        this.unwatchScopes();
        this.unwatchScopes = this.watchers.watch(homes, { recursive: true }, () =>
          this.resetCatalogs()
        );
        return {
          byUid: new Map(users.map((account, i) => [account.uid, homes[i] as string])),
          byBin: new Map(homes.map((home) => [`${home}/bin`, home])),
        };
      },
      () => ({ byUid: new Map(), byBin: new Map() })
    );
    return this.scopes;
  }

  private async userCommandDir(dir: string): Promise<ReadonlySet<string> | undefined> {
    const scope = (await this.userScopes()).byBin.get(dir);
    return scope === undefined ? undefined : this.ownCommands(scope);
  }

  private async scopeOf(uid: number): Promise<string> {
    return (await this.userScopes()).byUid.get(uid) ?? '';
  }

  private async commandAt(file: string, scope: string): Promise<Command | undefined> {
    const system = COMMAND.exec(file)?.[1];
    if (system !== undefined) return (await this.commands()).get(system);
    if (!file.includes('/')) return (await this.commands(scope)).get(file);
    const slash = file.lastIndexOf('/');
    const owner = (await this.userScopes()).byBin.get(file.slice(0, slash));
    if (owner === undefined || !(await this.ownCommands(owner)).has(file.slice(slash + 1))) {
      return undefined;
    }
    return (await this.commands(owner)).get(file.slice(slash + 1));
  }

  async resolve(file: string, argv0: string, cwd: string, scope = ''): Promise<Target | undefined> {
    if (!file.includes('/') || COMMAND.test(file)) {
      const command = await this.commandAt(file, scope);
      return command && !command.script ? targetOf(command) : undefined;
    }
    const path = this.fs.resolvePath(cwd, file);
    const glue = await followLinks(this.base, path);
    const asked = glue === path ? {} : { asked: path };
    const linked = COMMAND.exec(glue)?.[1];
    if (linked !== undefined) {
      const found = await this.resolve(`/bin/${linked}`, argv0, cwd);
      const target = found && { ...found, ...asked };
      const byPath = !COMMAND.test(path) && (await this.commands()).get(linked)?.argv0Path === true;
      return target && byPath ? { ...target, argv0: path } : target;
    }
    const own = await this.commandAt(glue, scope);
    if (own) return own.script ? undefined : { ...targetOf(own), ...asked };
    const head = await this.head(glue);
    if (!head) return undefined;
    if (isWasm(head)) {
      const owner = await this.wasmOwner(glue, baseName(file).replace(/\.wasm$/, ''), scope);
      if (owner) return { ...targetOf(owner), ...asked };
      return {
        abi: 'wasi',
        glue,
        wasm: glue,
        argv0: baseName(argv0 || file).replace(/\.wasm$/, ''),
        ...asked,
      };
    }
    if (interpreter(head) !== 'node') return undefined;
    const wasm = modulePath(glue);
    if (await this.base.exists(wasm)) {
      return { abi: 'emscripten', glue, wasm, argv0: baseName(argv0 || file), ...asked };
    }
    const owner = await this.glueOwner(glue, baseName(file), scope);
    return owner && { ...targetOf(owner), ...asked };
  }

  private async glueOwner(glue: string, name: string, scope: string): Promise<Command | undefined> {
    const owners = [...(await this.commands(scope)).values()].filter(
      (c) => c.abi === 'emscripten' && !c.script && c.glue === glue
    );
    return owners.find((c) => c.name === name) ?? owners[0];
  }

  private async wasmOwner(wasm: string, name: string, scope: string): Promise<Command | undefined> {
    const leaf = baseName(wasm);
    const real = await physicalPathAsync(this.base, wasm);
    const owners: Command[] = [];
    for (const command of (await this.commands(scope)).values()) {
      if (command.abi !== 'wasi' || command.script || baseName(command.wasm) !== leaf) continue;
      if (command.wasm === wasm || (await physicalPathAsync(this.base, command.wasm)) === real)
        owners.push(command);
    }
    return owners.find((c) => c.name === name) ?? owners[0];
  }

  private async head(path: string): Promise<Uint8Array | undefined> {
    try {
      return (await this.base.readFileBuffer(path)).subarray(0, SHEBANG_MAX);
    } catch {
      return undefined;
    }
  }

  private async scriptCommand(file: string, cwd: string, scope: string) {
    const direct = !file.includes('/') || COMMAND.test(file);
    const at = direct ? file : await followLinks(this.base, this.fs.resolvePath(cwd, file));
    const command = await this.commandAt(at, scope);
    return command?.script ? command : undefined;
  }

  private async interpreted(
    file: string,
    argv: string[],
    cwd: string,
    scope: string,
    depth = 0
  ): Promise<Planned | undefined> {
    const command = await this.scriptCommand(file, cwd, scope);
    const script = command?.script ?? this.fs.resolvePath(cwd, file);
    const byPath = command && file.includes('/') && !COMMAND.test(file);
    const named = byPath ? { [script]: this.fs.resolvePath(cwd, file) } : {};
    const head = await this.head(script);
    if (!head) return undefined;
    const binfmt = isWasm(head) ? undefined : binfmtOf(await this.interpreters(scope), script);
    const words = shebang(head) ?? (binfmt ? [binfmt] : undefined);
    if (!words) return undefined;
    const { interp, args } = shebangCommand(words);
    const passed = [...args, command ? script : file, ...argv.slice(1)];
    if (!interp) return undefined;
    const found = await this.resolve(interp, interp, cwd, scope);
    if (!found) {
      if (depth >= MAX_INTERPRETERS || !(await this.scriptCommand(interp, cwd, scope))) {
        return undefined;
      }
      const inner = await this.interpreted(interp, [interp, ...passed], cwd, scope, depth + 1);
      const via = [interp, ...(inner?.via ?? [])];
      const sources = [script, ...(inner?.sources ?? [])];
      const bins = [...(command?.bin ? [script] : []), ...(inner?.bins ?? [])];
      return (
        inner && {
          ...inner,
          target: withScriptEnv(inner.target, command),
          via,
          sources,
          ...(bins.length > 0 ? { bins } : {}),
          asked: { ...inner.asked, ...named },
        }
      );
    }
    const target = withScriptEnv(found, command);
    return {
      target,
      args: [...(target.prefix ?? []), ...passed],
      via: [interp],
      sources: [script],
      ...(command?.bin ? { bins: [script] } : {}),
      asked: named,
    };
  }

  private async plan(
    file: string,
    argv: string[],
    cwd: string,
    scope: string,
    argv0?: unknown
  ): Promise<Planned | undefined> {
    const found = await this.resolve(file, argv[0] ?? file, cwd, scope);
    const named = typeof argv0 === 'string' && found && !found.fixed;
    const direct = named ? { ...found, argv0 } : found;
    if (direct) return { target: direct, args: [...(direct.prefix ?? []), ...argv.slice(1)] };
    const script = await this.interpreted(file, argv, cwd, scope);
    return script && { ...script, script: true };
  }

  private async mayExec(
    cred: Readonly<Cred>,
    req: { file: string; cwd: string; pid: number; tag?: string | undefined },
    planned: Planned | undefined
  ): Promise<void> {
    const { dac } = this;
    if (!dac) return;
    const g = {
      fs: this.fs,
      cred,
      pid: req.pid,
      dac,
      tag: req.tag,
      links: this.links.get(req.pid),
    };
    const byPath = (file: string) => file.includes('/') && !COMMAND.test(file);
    if (byPath(req.file)) {
      const path = this.fs.resolvePath(req.cwd, req.file);
      await need(g, 'exec', path, planned?.script ? R_OK | X_OK : X_OK);
    }
    const via = planned?.via ?? [];
    for (const [i, file] of via.entries()) {
      if (!byPath(file)) continue;
      const want = i < via.length - 1 ? R_OK | X_OK : X_OK;
      await need(g, 'exec', this.fs.resolvePath(req.cwd, file), want);
    }
    for (const bin of planned?.bins ?? []) await need(g, 'exec', bin, R_OK | X_OK);
  }

  private async checkedPlan(
    req: ChildSpawnRequest,
    { ppid, cred, scope }: { ppid: number; cred: Readonly<Cred>; scope: string },
    fds: FdTable
  ): Promise<Planned> {
    const refused = async (err: unknown): Promise<never> => {
      await fds.closeAll();
      throw (err as { code?: unknown }).code === 'EACCES' ? new SpawnError('EACCES') : err;
    };
    const file = await this.execFile(req.file, req.cwd, this.execGuard(cred, ppid)).catch(refused);
    const planned = await this.plan(file, req.argv, req.cwd, scope, req.argv0);
    await this.mayExec(cred, { ...req, file, pid: ppid }, planned).catch(refused);
    if (planned) return planned;
    await fds.closeAll();
    throw new SpawnError(await this.unrunnable(file, req.cwd, scope));
  }

  private execGuard(cred: Readonly<Cred>, pid: number, tag?: string): Guard | undefined {
    const { dac } = this;
    return dac && { fs: this.fs, cred, pid, dac, tag, links: this.links.get(pid) };
  }

  private async execFile(file: string, cwd: string, g?: Guard): Promise<string> {
    if (!file.split('/').includes('..')) return file;
    const path = file.startsWith('/') ? file : `${cwd}/${file}`;
    const slash = path.lastIndexOf('/');
    const dir = path.slice(0, slash);
    const walked = g && (await need(g, 'exec', dir, X_OK, { directory: true }));
    const real =
      walked && walked.denied === undefined ? walked.path : await physicalPathAsync(this.base, dir);
    return joinName(real, path.slice(slash + 1));
  }

  private async ticketFile(req: ChildSpawnRequest, fds: FdTable): Promise<string> {
    if (req.file.startsWith('/')) return physicalPathAsync(this.base, req.file);
    await fds.closeAll();
    throw new SpawnError('EACCES');
  }

  private takeTicket(req: ChildSpawnRequest): Booked | null | undefined {
    if (!(TICKET_ENV in req.env)) return undefined;
    return this.sealed.tickets.take(req.env[TICKET_ENV] ?? '') ?? null;
  }

  private async redeemed(
    req: ChildSpawnRequest,
    who: Redeemer,
    planned: Planned,
    fds: FdTable
  ): Promise<{ env: Record<string, string>; pid?: number; cwd?: string; scrub?: Scrubber }> {
    if (who.booked === undefined) return { env: req.env };
    try {
      const redeemed = await this.redeem(req, who, planned);
      if (redeemed.scrub) scrubStdio(fds, redeemed.scrub);
      return redeemed;
    } catch {
      await fds.closeAll();
      throw new SpawnError('EACCES');
    }
  }

  private async redeem(
    req: ChildSpawnRequest,
    { ppid, cred, scope, booked }: Redeemer,
    planned: Planned
  ): Promise<{ env: Record<string, string>; pid: number; cwd: string; scrub?: Scrubber }> {
    const { [TICKET_ENV]: ticket = '', ...env } = req.env;
    const caller = this.jobs.shown(ppid);
    const named = typeof req.argv0 === 'string' && !planned.script && !planned.target.fixed;
    const argv = named ? [req.argv0 as string, ...req.argv.slice(1)] : req.argv;
    const exact =
      booked?.pid === caller &&
      req.file === booked.path &&
      (await physicalPathAsync(this.base, req.cwd)) === booked.cwd &&
      (await argvDigest(argv)) === booked.argv;
    if (!exact) throw new SpawnError('EACCES');
    const { requested: path, requestedCwd: cwd, path: resolved } = booked;
    const pid = this.nextPid++;
    const ids = { pid: req.exec ? caller : pid, ppid: caller };
    const stamp = await this.sealed.stamp(ids, cred, this.tagOf(ppid));
    const interpreters = await this.interpreterChain(planned, booked.cwd, scope);
    const trusted =
      this.usersMode === 'enforce' &&
      (await this.trustedFiles(planned, req.file, booked.cwd, scope));
    const swap = await this.sealed.consume({
      ticket,
      stamp,
      path,
      resolved,
      argv,
      cwd,
      interpreters,
      trusted,
    });
    if (!swap) throw new SpawnError('EACCES');
    const secrets: ScrubSecret[] = [];
    for (const [name, placeholder] of Object.entries(swap.placeholders)) {
      const value = swap.values[name];
      if (value === undefined || env[name] !== placeholder) continue;
      env[name] = value;
      secrets.push({ name, value, placeholder });
    }
    const scrub = scrubberOf(secrets);
    return { env, pid, cwd: booked.cwd, ...(scrub ? { scrub } : {}) };
  }

  private async interpreterChain(planned: Planned, cwd: string, scope: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of planned.via ?? []) {
      if (entry.includes('/')) {
        out.push(await physicalPathAsync(this.base, this.fs.resolvePath(cwd, entry)));
        continue;
      }
      const script = (await this.scriptCommand(entry, cwd, scope))?.script;
      out.push(
        await physicalPathAsync(this.base, script ?? (await this.commandFile(entry, cwd, scope)))
      );
    }
    return out;
  }

  private async commandFile(name: string, cwd: string, scope: string): Promise<string> {
    const scoped = await this.resolve(name, name, cwd, scope);
    const system = scope === '' ? scoped : await this.resolve(name, name, cwd, '');
    if (!scoped || system?.glue === scoped.glue) return `/usr/bin/${name}`;
    return scoped.glue;
  }

  private async trustedFiles(
    planned: Planned,
    file: string,
    cwd: string,
    scope: string
  ): Promise<boolean> {
    const files = await this.backingOf(planned, file, cwd, scope);
    for (const at of files) {
      if (!(await rootOnly(this.base, await physicalPathAsync(this.base, at)))) return false;
    }
    return true;
  }

  private async grantedCwd(caller: Cred, cwd: string): Promise<boolean> {
    const real = await physicalPathAsync(this.base, cwd).catch(() => undefined);
    return real === cwd && (await this.sudoer.reachable(caller, cwd));
  }

  private async binfmtManifests(scripts: string[]): Promise<string[]> {
    const sources = new Map<string, string>();
    const binfmts = await scanBinfmts(this.scanned, await this.roots(), undefined, sources);
    const manifests: string[] = [];
    for (const script of scripts) {
      const head = await this.head(script);
      if (!head || isWasm(head) || shebang(head)) continue;
      const pkg = sources.get(binfmtSuffix(binfmts, script) ?? '');
      if (pkg !== undefined) manifests.push(`${pkg}/package.json`);
    }
    return manifests;
  }

  private async backing(asked: string, cwd: string): Promise<string[] | undefined> {
    const file = await this.execFile(asked, cwd);
    const planned = await this.plan(file, [file], cwd, '');
    return planned && this.backingOf(planned, file, cwd, '');
  }

  private async backingOf(
    planned: Planned,
    file: string,
    cwd: string,
    scope: string
  ): Promise<string[]> {
    const { glue, wasm, imports } = planned.target;
    const files = [glue, wasm, ...(imports ? [imports] : [])];
    const scripts: string[] = [];
    for (const name of [file, ...(planned.via ?? [])]) {
      if (name.includes('/') && !COMMAND.test(name)) scripts.push(this.fs.resolvePath(cwd, name));
      const script = (await this.scriptCommand(name, cwd, scope))?.script;
      if (script) scripts.push(script);
    }
    files.push(...scripts, ...(await this.binfmtManifests(scripts)));
    const roots = await this.roots();
    for (const at of [...files]) {
      const root = packageRootOf(at, roots) ?? PACKAGE_ROOT.exec(at)?.[1];
      if (root !== undefined) files.push(`${root}/package.json`);
    }
    return [...new Set(files)].filter((path) => path !== '' && path !== SUDO_PATH);
  }

  private async unrunnable(
    file: string,
    cwd: string,
    scope: string
  ): Promise<'ENOEXEC' | 'ENOENT' | 'EACCES'> {
    const path = this.fs.resolvePath(cwd, file);
    if (await this.directory(file, path)) return 'EACCES';
    const head = await this.base.readFileBuffer(path).catch(() => null);
    if (!head || (head[0] === 0x23 && head[1] === 0x21)) return 'ENOENT';
    return binfmtOf(await this.interpreters(scope), path) ? 'ENOENT' : 'ENOEXEC';
  }

  private async directory(file: string, path: string): Promise<boolean> {
    if (!file.includes('/') || COMMAND.test(file)) return false;
    return (await this.base.stat(path).catch(() => undefined))?.isDirectory === true;
  }

  verifiedFs(fs: KernelFs): KernelFs {
    const read = (path: string) => this.verified(path, KERNEL_CALLER, fs);
    return Object.assign(Object.create(fs) as KernelFs, {
      readFileBuffer: read,
      readFile: (path: string) =>
        this.integrity ? this.text(path, KERNEL_CALLER) : fs.readFile(path),
    });
  }

  private async cacheKey(path: string, asked?: string): Promise<string> {
    const verified = await this.integrity?.key(path, asked);
    if (verified !== undefined) return verified;
    const st = await this.base.stat(path);
    return `${path}:${st.size}:${st.mtime.getTime()}`;
  }

  private verified(path: string, caller: IntegrityCaller, fs = this.base): Promise<Uint8Array> {
    const plain = () => fs.readFileBuffer(path);
    return this.integrity ? this.integrity.read(path, caller, plain) : plain();
  }

  private keyed(
    path: string,
    caller: IntegrityCaller,
    asked?: string
  ): Promise<{ bytes: Uint8Array; key?: string | undefined }> {
    const plain = async () => this.base.readFileBuffer(path);
    return this.integrity
      ? this.integrity.readKeyed(path, caller, plain, asked)
      : plain().then((bytes) => ({ bytes }));
  }

  private cached<T>(
    cache: Map<string, Promise<T>>,
    key: string,
    load: () => Promise<{ value: T; key?: string | undefined }>
  ): Promise<T> {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const revocations = this.revocations;
    const loading = load();
    const found = loading.then(({ value }) => value);
    cache.set(key, found);
    const drop = () => {
      if (cache.get(key) === found) cache.delete(key);
    };
    loading.then((done) => {
      if (done.key === key || (done.key === undefined && !key.includes('\0'))) return;
      drop();
      if (done.key !== undefined && revocations === this.revocations) cache.set(done.key, found);
    }, drop);
    return found;
  }

  private async module(path: string, caller: IntegrityCaller, asked?: string): Promise<Compiled> {
    const key = await this.cacheKey(path, asked);
    return this.cached(this.compiled, key, async () => {
      const { bytes, key: read } = await this.keyed(path, caller, asked);
      const memory = importedMemory(bytes);
      const foreign = foreignImports(bytes);
      const compiled = await WebAssembly.compile(bytes as BufferSource);
      return { value: { module: compiled, ...(memory ? { memory } : {}), foreign }, key: read };
    });
  }

  private async checkedSources(planned: Planned, caller: IntegrityCaller): Promise<void> {
    const { target } = planned;
    const files = [
      target.wasm,
      target.glue,
      target.imports,
      target.asked,
      ...(planned.sources ?? []),
    ];
    const manifests = new Set<string>();
    for (const file of files) {
      const root = file === undefined ? undefined : PACKAGE_ROOT.exec(file)?.[1];
      if (root !== undefined) manifests.add(`${root}/package.json`);
    }
    for (const source of planned.sources ?? []) {
      await this.text(source, caller, planned.asked?.[source]);
    }
    for (const manifest of manifests) {
      if (await this.base.exists(manifest)) await this.text(manifest, caller);
    }
  }

  private async text(path: string, caller: IntegrityCaller, asked?: string): Promise<string> {
    if (!this.integrity) return this.base.readFile(path);
    const key = await this.cacheKey(path, asked);
    return this.cached(this.texts, key, async () => {
      const { bytes, key: read } = await this.keyed(path, caller, asked);
      return { value: new TextDecoder().decode(bytes), key: read };
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

  private async program(
    target: Target,
    env: Record<string, string>,
    caller: IntegrityCaller
  ): Promise<Program> {
    if (target.abi === 'js' && target.wasm === SUDO_PATH) {
      return { abi: 'js', glue: SUDO_SOURCE, path: SUDO_PATH };
    }
    const { asked } = target;
    if (target.abi === 'js') {
      return { abi: 'js', glue: await this.text(target.wasm, caller, asked), path: target.wasm };
    }
    if (target.abi !== 'wasi') {
      const [glue, { module }] = await Promise.all([
        this.text(target.glue, caller, asked),
        this.module(target.wasm, caller, asked && modulePath(asked)),
      ]);
      return { glue, module };
    }
    const { module, memory, foreign } = await this.module(target.wasm, caller, asked);
    const names =
      env.SLICC_WASM_BACKTRACE === '1' ? await this.names(target.wasm, module) : undefined;
    const imports = target.imports ? await this.text(target.imports, caller) : undefined;
    return {
      abi: 'wasi',
      glue: '',
      module,
      ...(memory ? { memory } : {}),
      foreign,
      path: target.wasm,
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
    const cwd = await physicalPathAsync(this.base, req.cwd);
    const seen = { ...req.env, HOSTNAME: this.hostname, cwd };
    const env = { ...expandDefaults(target.env, seen), ...req.env };
    for (const key of target.unset ?? []) delete env[key];
    delete env[TICKET_ENV];
    env.HOSTNAME = this.hostname;
    let program: Program;
    await this.pnpmReady();
    try {
      const caller = { pid: req.ppid ?? 0, uid: req.cred.euid, tag: req.tag };
      if (this.integrity) await this.checkedSources(planned, caller);
      program = await this.program(target, env, caller);
    } catch (err) {
      await req.fds.closeAll();
      throw err;
    }
    return this.start({ ...req, cwd, program, argv0: target.argv0, args, env });
  }

  groupSession(pgid: number): number | undefined {
    return this.jobs.sessionOf(pgid);
  }

  private loopbackFor(pid: number): KernelLoopback {
    return new KernelLoopback(
      this.net,
      () => {
        const cred = this.credOf(pid);
        return { pid, uid: cred.euid, gid: cred.egid };
      },
      () => this.connectorStamp(pid)
    );
  }

  private sourceCheck(pid: number, writer: boolean): { source?: SourceCheck } {
    const { integrity } = this;
    if (!integrity?.readsChecked || writer) return {};
    const caller = (): IntegrityCaller => ({
      pid,
      uid: this.credOf(pid).euid,
      tag: this.tagOf(pid),
    });
    return {
      source: {
        read: (path, plain) => integrity.readSource(path, caller(), plain),
        open: (path, real) => integrity.openSource(path, caller(), real),
      },
    };
  }

  private treeScrubs(req: StartRequest): Scrubber[] | undefined {
    const inherited = req.ppid !== undefined ? this.scrubs.get(req.ppid) : undefined;
    return req.scrub ? [...(inherited ?? []), req.scrub] : inherited;
  }

  private marks(pid: number, req: StartRequest): void {
    if (req.tag !== undefined) this.tags.set(pid, req.tag);
    if (req.links !== undefined) this.links.set(pid, req.links);
  }

  private start(req: StartRequest): WasmProcessHandle {
    this.sampling();
    if (req.pgid !== undefined && this.jobs.sessionOf(req.pgid) === undefined) {
      throw new SpawnError('ESRCH');
    }
    const pid = req.pid ?? this.nextPid++;
    const scrubs = this.treeScrubs(req);
    const stack = this.stackFor(req.tag);
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
      settling: () => this.settling.isSettling(pid),
      ...(req.ignored ? { ignored: req.ignored } : {}),
      ...(anyBlocked(req.blocked) ? { blocked: req.blocked } : {}),
      ...(req.umask !== undefined ? { umask: req.umask } : {}),
      cred: req.cred,
      ...(this.owners && req.program.abi === 'wasi'
        ? { fresh: (path: string, umask: number) => this.freshModules.add(path, umask, pid) }
        : {}),
      ...(this.owners ? { owners: true } : {}),
      ...this.sourceCheck(pid, stack.writer),
      ...linksOf(req),
      sealed: this.sealed,
      ...(scrubs ? { outputFilter: (file: OpenFile) => scrubbedAll(file, scrubs) } : {}),
      clipboard: this.clipboard,
      ...(this.dac ? { dac: this.dac } : {}),
      program: req.program,
      changes: this.changes.sab,
      argv0: req.argv0,
      args: req.args,
      env: req.env,
      cwd: req.cwd,
      fds: req.fds,
      fs: stack.fs,
      noLinks: stack.noLinks,
      ...(this.prefixes.length > 0 && !stack.writer
        ? { readonlyAt: (path: string) => isProtected(this.prefixes, path) }
        : {}),
      createWorker: this.createWorker,
      onError: req.report,
      spawner: this.spawner(pid, req.report),
      forker: this.forker(pid, req),
      kill: (target, sig) => this.kill(target, sig, this.credOf(pid), pid),
      writesBack: (target) => this.processes.get(target)?.writesBack() === true,
      processes: () => ({
        boot: this.boot,
        processes: this.list(this.credOf(pid)),
        load: this.loadAverage(),
        cpu: this.cpuTotal(),
      }),
      sudo: (call, signal) => this.sudo(pid, call, signal),
      openFiles: this.openFiles,
      nodes: stack.nodes,
      held: this.held,
      unlinkGate: stack.unlinked.gate,
      statfs: (path) => this.mounts.statfs(path),
      mounts: () => this.mounts.list(),
      mount: (call, signal) => this.processMount(pid, call, signal),
      umount: (target, flags) => this.processUmount(pid, target, flags),
      jobs: this.jobs,
      ptys: this.ptys,
      net: this.net,
      http: new HttpHandles(this.transport, pid, this.loopbackFor(pid)),
      locks: this.locks,
      sems: this.sems,
      resolver: this.resolver,
      onReap: (child) => this.reaped(child, pid),
      ...(req.fork ? { fork: req.fork } : {}),
      ...this.shownIds(req),
    });
    this.processes.set(pid, handle);
    if (scrubs) this.scrubs.set(pid, scrubs);
    const { cred } = req;
    this.creds.set(pid, () => handle.cred?.() ?? copyCred(cred));
    this.marks(pid, req);
    if (req.ppid !== undefined && this.controlsJobs(req.ppid)) this.settling.started(pid, req.ppid);
    this.jobs.add(pid, req.ppid, (sig) => handle.signal(sig), terminal);
    if (req.exec && req.ppid !== undefined) this.jobs.exec(req.ppid, pid, true);
    if (req.pgid !== undefined) this.jobs.join(pid, req.pgid);
    if (req.group === 'lead') this.jobs.lead(pid);
    if (req.group === 'session') this.jobs.setsid(pid);
    this.described.set(pid, {
      argv: [req.argv0, ...req.args],
      tty: terminal?.name ?? null,
      started: Date.now(),
    });
    handle.onState((state) =>
      state === 'stopped' ? this.stopped.add(pid) : this.stopped.delete(pid)
    );
    void handle.exited.then(() => {
      this.freshModules.forget(pid);
      const spent = handle.times?.();
      if (spent) this.spent.set(pid, spent);
      if (spent) addTimes(this.imageTimes, this.jobs.shown(pid), spent);
      this.stopped.delete(pid);
      this.processes.delete(pid);
      this.scrubs.delete(pid);
      if (this.processes.size === 0) {
        clearInterval(this.sampler);
        this.sampler = undefined;
        this.idleSince = Date.now();
      }
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
    const image = this.jobs.list().find((m) => m.pid === pid)?.execParent;
    const described = this.described.get(pid);
    if (image !== undefined && described && this.described.has(image)) {
      this.described.set(image, described);
    }
    this.jobs.remove(pid);
    this.described.delete(pid);
    const spent = this.spent.get(pid);
    if (spent) {
      this.reapedTimes.utime += spent.utime;
      this.reapedTimes.stime += spent.stime;
    }
    this.spent.delete(pid);
    this.imageTimes.delete(pid);
    this.childTimes.delete(pid);
    this.creds.delete(pid);
    this.tags.delete(pid);
    this.links.delete(pid);
    this.granted.delete(pid);
  }

  private reaped(pid: number, parent: number): void {
    const own = this.imageTimes.get(pid);
    const theirs = this.childTimes.get(pid);
    const into = this.jobs.shown(parent);
    if (own) addTimes(this.childTimes, into, own);
    if (theirs) addTimes(this.childTimes, into, theirs);
    this.imageTimes.delete(pid);
    this.childTimes.delete(pid);
    if (this.zombies.delete(pid)) this.forget(pid);
    else this.orphans.add(pid);
  }

  private load: [number, number, number] = [0, 0, 0];
  private sampler: ReturnType<typeof setInterval> | undefined;
  private readonly reapedTimes: CpuTimes = { utime: 0, stime: 0 };

  private readonly idleAt = { wall: this.boot, busy: 0, idle: 0 };

  cpuTotal(now = Date.now()): CpuTimes & { idle: number } {
    const total = { ...this.reapedTimes };
    const add = (t: CpuTimes | undefined) => {
      total.utime += t?.utime ?? 0;
      total.stime += t?.stime ?? 0;
    };
    for (const handle of this.processes.values()) add(handle.times?.());
    for (const t of this.spent.values()) add(t);
    const busy = total.utime + total.stime;
    const at = this.idleAt;
    at.idle += Math.max(0, now - at.wall - (busy - at.busy));
    at.wall = Math.max(at.wall, now);
    at.busy = Math.max(at.busy, busy);
    return { ...total, idle: at.idle };
  }

  loadAverage(): readonly [number, number, number] {
    return this.load;
  }

  private sampledAt = Date.now();

  sampleLoad(now = Date.now()): void {
    let running = 0;
    for (const handle of this.processes.values()) running += handle.running?.() ?? 0;
    const elapsed = Math.max(LOAD_SAMPLE_MS, now - this.sampledAt);
    this.sampledAt = Math.max(this.sampledAt, now);
    this.load = this.load.map((avg, i) => {
      const window = LOAD_WINDOWS_MS[i as 0 | 1 | 2];
      const fresh = 1 - Math.exp(-LOAD_SAMPLE_MS / window);
      return avg * Math.exp(-elapsed / window) + running * fresh;
    }) as [number, number, number];
  }

  private idleSince: number | undefined;

  private sampling(): void {
    if (this.sampler) return;
    if (this.idleSince !== undefined) {
      const empty = Math.max(0, Date.now() - this.idleSince);
      this.load = this.load.map(
        (avg, i) => avg * Math.exp(-empty / LOAD_WINDOWS_MS[i as 0 | 1 | 2])
      ) as [number, number, number];
    }
    this.sampledAt = Date.now();
    this.sampler = setInterval(() => this.sampleLoad(), LOAD_SAMPLE_MS);
    (this.sampler as { unref?: () => void }).unref?.();
  }

  private readonly spent = new Map<number, CpuTimes>();
  private readonly imageTimes = new Map<number, CpuTimes>();
  private readonly childTimes = new Map<number, CpuTimes>();
  private readonly stopped = new Set<number>();

  private stateOf(pid: number): ProcessInfo['state'] {
    if (!this.processes.has(pid)) return 'Z';
    return this.stopped.has(pid) ? 'T' : 'S';
  }

  private childrenOf(pid: number): { cutime?: number; cstime?: number } {
    const t = this.childTimes.get(pid);
    return t ? { cutime: t.utime, cstime: t.stime } : {};
  }

  private timesAt(pid: number): CpuTimes | undefined {
    return this.processes.get(pid)?.times?.() ?? this.spent.get(pid);
  }

  private timesOf(
    member: JobMember,
    members: Map<number, JobMember>
  ): { utime?: number; stime?: number } {
    let utime = 0;
    let stime = 0;
    let timed = false;
    for (let at: JobMember | undefined = member; at; at = members.get(at.execParent ?? -1)) {
      const t = this.timesAt(at.pid);
      if (!t) continue;
      timed = true;
      utime += t.utime;
      stime += t.stime;
    }
    return timed ? { utime, stime } : {};
  }

  list(viewer: Readonly<Cred> = ROOT): ProcessInfo[] {
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
    const superseded = new Set([...members.values()].map((m) => m.execParent));
    const listed: ProcessInfo[] = [];
    for (const member of members.values()) {
      const described = this.described.get(member.pid);
      if ((member.execed && superseded.has(member.pid)) || !described) continue;
      const cred = this.credOf(member.pid);
      if (!maySee(viewer, cred)) continue;
      const root = rootOf(member);
      const tag = this.tagOf(member.pid) ?? this.tagOf(root.pid);
      listed.push({
        pid: root.pid,
        tid: member.pid,
        ppid: shown(root.ppid),
        pgid: member.pgid,
        sid: member.sid,
        ...described,
        started: (this.described.get(root.pid) ?? described).started,
        state: this.stateOf(member.pid),
        ...this.threadsOf(member.pid),
        memory: this.processes.get(member.pid)?.memory() ?? 0,
        ...this.timesOf(member, members),
        ...this.childrenOf(root.pid),
        umask: this.umaskOf(member.pid),
        cred,
        ...this.signalMasksOf(member.pid),
        ...(tag !== undefined && maySee(viewer, cred) ? { tag } : {}),
      });
    }
    return listed;
  }

  private threadsOf(pid: number): Pick<ProcessInfo, 'threads'> {
    const threads = this.stateOf(pid) === 'S' ? this.processes.get(pid)?.threads?.() : undefined;
    return threads ? { threads } : {};
  }

  private sudo(pid: number, call: SudoCall, signal: AbortSignal): Promise<SudoResult> {
    const caller = {
      cred: this.credOf(pid),
      pid: this.jobs.shown(pid),
      tag: this.tagOf(pid),
      tty: this.described.get(pid)?.tty,
    };
    return this.sudoer.request(caller, call, signal);
  }

  private spawner(ppid: number, report: (message: string) => void): ChildSpawner {
    return async (req, fds, grant) => {
      const booked = this.takeTicket(req);
      if (grant && !(await this.grantedCwd(grant.caller, req.cwd))) {
        await fds.closeAll();
        throw new SpawnError('EACCES');
      }
      const group = this.childGroup(ppid, req);
      if (typeof group === 'string') {
        await fds.closeAll();
        throw new SpawnError(group);
      }
      const cred = grant ? grant.cred : this.credOf(ppid);
      const scope = grant ? '' : await this.scopeOf(cred.euid);
      const file = booked === undefined ? req.file : await this.ticketFile(req, fds);
      const planned = await this.checkedPlan({ ...req, file }, { ppid, cred, scope }, fds);
      const redeemed = await this.redeemed(
        { ...req, file },
        { ppid, cred, scope, booked },
        planned,
        fds
      );
      const exec = req.exec ? { exec: true } : {};
      const deciding = req.exec ? undefined : this.undecided(ppid);
      const handle = await this.launch(planned, {
        ...(deciding ? { decided: deciding.promise } : {}),
        cwd: req.cwd,
        ...redeemed,
        fds,
        report,
        ppid,
        ignored: this.ignoredBy(ppid),
        blocked: this.blockedBy(ppid),
        umask: this.umaskOf(ppid),
        cred,
        tag: this.tagOf(ppid),
        links: grant ? grant.cred.euid : this.links.get(ppid),
        ...group,
        ...exec,
      });
      deciding?.attach();
      if (grant) this.granted.set(handle.pid, ppid);
      return childHandle(handle);
    };
  }

  private childGroup(
    ppid: number,
    req: { pgid?: unknown; session?: unknown; exec?: boolean }
  ): { pgid?: number; group?: 'lead' | 'session' } | 'EINVAL' | 'ESRCH' | 'EPERM' {
    const { pgid, session } = req;
    if (pgid === undefined && session === undefined) return {};
    const valid = pgid === undefined || (Number.isInteger(pgid) && (pgid as number) >= 0);
    if (req.exec || !valid || (session !== undefined && session !== true)) return 'EINVAL';
    if (session) return pgid === undefined ? { group: 'session' } : 'EINVAL';
    if (pgid === 0) return { group: 'lead' };
    const sid = this.jobs.sessionOf(pgid as number);
    if (sid === undefined) return 'ESRCH';
    return sid === this.jobs.sidOf(ppid) ? { pgid: pgid as number } : 'EPERM';
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

  connectorStamp(pid: number): Promise<SealedCaller> {
    return this.sealed.stamp(this.identityOf(pid), this.credOf(pid), this.tagOf(pid));
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
    const { exec: _exec, pgid: _pgid, group: _group, pid: _pid, scrub: _scrub, ...image } = parent;
    return async (state, fds) =>
      childHandle(
        this.start({
          ...image,
          cwd: state.cwd ?? parent.cwd,
          fds,
          ppid,
          fork: state,
          ignored: this.ignoredBy(ppid, true),
          blocked: this.blockedBy(ppid),
          umask: this.umaskOf(ppid),
          cred: this.credOf(ppid),
          tag: this.tagOf(ppid),
          links: this.links.get(ppid),
        })
      );
  }

  private keySignal(tty: KernelTty, fallback: number, sig: number, send: () => void): void {
    const pgid = this.jobs.tcgetpgrp(tty, fallback);
    const foreground = () => this.jobs.tcgetpgrp(tty, fallback);
    const keyed = () => this.jobs.fromKeyboard(send);
    this.settling.deliver(sig, pgid, keyed, tty.reading ? undefined : foreground);
  }

  private async resolvePrefixes(): Promise<void> {
    for (const prefix of [...this.prefixes]) {
      const real = await this.base.realpath?.(prefix, true).catch(() => undefined);
      if (real !== undefined && !this.prefixes.includes(real)) this.prefixes.push(real);
    }
  }

  private guardMount(target: string): void {
    const at = normalizePath(target);
    if (isProtected(this.prefixes, at) || holdsProtected(this.prefixes, at)) {
      throw fsError('EROFS', at);
    }
  }

  private umaskOf(pid: number): number {
    return this.processes.get(pid)?.umask?.() ?? DEFAULT_UMASK;
  }

  private imageOf(pid: number): number {
    const members = this.jobs.list();
    let image = pid;
    for (;;) {
      const next = members.find((m) => m.execParent === image);
      if (!next) return image;
      image = next.pid;
    }
  }

  credOf(pid: number): Cred {
    return this.creds.get(pid)?.() ?? copyCred(ROOT);
  }

  tagOf(pid: number): string | undefined {
    return this.tags.get(pid);
  }

  private released(path: string): void {
    const at = normalizePath(path);
    this.unlinked.closed(at);
    this.writers?.unlinked.closed(at);
    const open = [...this.openFiles].some((nodes) => nodes.writes(at)) || heldUnder(this.held, at);
    if (!open) void this.mounts.commit(at).catch(() => undefined);
  }

  private signalMasksOf(pid: number): { sigIgn?: number; sigCgt?: number; sigBlk?: number } {
    const masks = this.processes.get(pid)?.signalMasks?.();
    const [blocked] = this.blockedBy(pid);
    const sigBlk = blocked ? { sigBlk: blocked } : {};
    return masks ? { sigIgn: masks.ignored, sigCgt: masks.caught, ...sigBlk } : sigBlk;
  }

  private controlsJobs(pid: number): boolean {
    return this.settling.isSettling(pid) || (this.ignoredBy(pid) & sigbit(SIG.TTOU)) !== 0;
  }

  private blockedBy(pid: number): BlockedMask {
    return this.processes.get(pid)?.blockedSignals?.() ?? [0, 0];
  }

  private ignoredBy(pid: number, fork = false): number {
    return this.processes.get(pid)?.ignoredSignals(fork) ?? 0;
  }

  kill(pid: number, sig: number, sender?: Readonly<Cred>, from?: number): boolean {
    const session = from === undefined ? undefined : this.jobs.sidOf(from);
    const may = (target: number) =>
      !sender ||
      maySignal(sender, this.credOf(target)) ||
      (sig === SIG.CONT && session !== undefined && this.jobs.sidOf(target) === session) ||
      (from !== undefined && this.imageOf(from) === this.imageOf(target)) ||
      (from !== undefined && this.granted.get(this.jobs.shown(target)) === from) ||
      (from !== undefined && this.granted.get(this.jobs.pgidOf(target) ?? 0) === from);
    if (pid === -1) {
      const sender = from === undefined ? undefined : this.imageOf(from);
      return this.killAll(sig, (member) => this.imageOf(member) !== sender, may);
    }
    if (pid < 0) return this.jobs.killGroup(-pid, sig, (member) => may(this.imageOf(member)));
    const handle = this.processes.get(pid);
    if (!handle) return false;
    if (!may(this.imageOf(pid))) throw fsError('EPERM', `pid ${pid}`);
    if (sig !== 0) handle.signal(sig);
    return true;
  }

  private killAll(
    sig: number,
    other: (pid: number) => boolean,
    may: (pid: number) => boolean
  ): boolean {
    const candidates = [...this.processes].filter(([pid]) => pid !== 1 && other(pid));
    const targets = candidates.filter(([pid]) => may(this.imageOf(pid)));
    if (targets.length === 0 && candidates.length > 0) throw fsError('EPERM', 'kill -1');
    const pids = new Set(targets.map(([pid]) => pid));
    const parents = new Map(this.jobs.list().map((m) => [m.pid, m.execParent]));
    for (const [pid, handle] of targets) {
      const parent = parents.get(pid);
      if (sig !== 0 && (parent === undefined || !pids.has(parent))) handle.signal(sig);
    }
    return targets.length > 0;
  }

  private async driver(type: string, spec: MountSpec): Promise<OpenedDriver> {
    if (type === 'fsa') return this.fsaDriver(spec);
    if (type === 'hostfs') {
      const { hostfs, hostfsFetch, hostfsTiming } = this.hostfs;
      if (!hostfs)
        throw fsError('ENODEV', 'this kernel has no hostfs hook (createKernel({ hostfs }))');
      return openHostfs(
        spec,
        grantConnect(hostfs, hostfsFetch ?? ((url, init) => fetch(url, init)), hostfsTiming),
        hostfsTiming
      );
    }
    if (type === 'tmpfs') {
      const { port1, port2 } = new MessageChannel();
      serveFilesystem(
        port2,
        tmpfs(),
        {
          symlinks: true,
          links: true,
          chmod: true,
          owners: true,
          linkTimes: true,
          ranges: true,
          attrTtl: 0,
        },
        { owned: true }
      );
      if (spec.target === SHM) (port2 as { unref?: () => void }).unref?.();
      return {
        port: port1,
        ...(spec.target === SHM ? { idle: true as const } : {}),
        dispose: () => {
          port1.close();
          port2.close();
        },
      };
    }
    const module = (await scanFilesystems(this.scanned, await this.roots())).get(type);
    if (!module) throw fsError('ENODEV', `unknown file system type ${type}`);
    if (!this.createDriverWorker)
      throw fsError('ENODEV', `this kernel cannot start ${type} drivers`);
    const root = PACKAGE_ROOT.exec(module)?.[1];
    if (this.integrity && root !== undefined)
      await this.text(`${root}/package.json`, KERNEL_CALLER);
    const code = new TextDecoder().decode(await this.verified(module, KERNEL_CALLER));
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

  async revokeIntegrity(path?: string): Promise<void> {
    if (path !== undefined && (typeof path !== 'string' || !path.startsWith('/'))) {
      throw new TypeError('integrity.revoke takes an absolute path');
    }
    if (!this.integrity) return;
    const at = path === undefined ? undefined : normalizePath(path);
    const real = at && (await this.base.realpath?.(at, true).catch(() => undefined));
    const roots = [at, real].filter((p): p is string => p !== undefined);
    this.revocations++;
    const hit = (key: string) =>
      key.includes('\0') &&
      (at === undefined ||
        key
          .split('\0')
          .slice(0, 2)
          .some((part) => isProtected(roots, part)));
    for (const cache of [this.compiled, this.texts] as Map<string, unknown>[]) {
      for (const key of [...cache.keys()]) if (hit(key)) cache.delete(key);
    }
    if (at === undefined) this.integrity.forget();
    for (const root of roots) this.integrity.forget(root);
    this.resetCatalogs();
  }

  attest(path: string): Promise<Attestation> {
    return attest(this.rootFs, path, {
      users: this.usersMode,
      mounts: this.mounts
        .list()
        .map((entry) => entry.target)
        .filter((target) => this.mounts.mounted(target) !== undefined),
    });
  }

  watchFiles(paths: readonly string[], notify: (path: string) => void): Promise<() => void> {
    this.fileWatches ??= new FileWatches(this.watchers, this.rootFs as RemoteFs);
    return this.fileWatches.watch(paths, notify);
  }

  async mount(spec: MountSpec): Promise<MountEntry> {
    this.guardMount(spec.target);
    const fsa = spec.type === 'fsa' && !spec.source.startsWith('fsa:');
    const entry = await this.mounts.mount(
      fsa ? { ...spec, source: `fsa:${crypto.randomUUID()}` } : spec,
      this.fs
    );
    void this.unlinked.sweep(entry.target);
    this.pnpmStale();
    return entry;
  }

  private async mountShm(): Promise<void> {
    await this.base.mkdir(SHM, { recursive: true });
    await this.mounts.mountSystem({ type: 'tmpfs', source: 'shm', target: SHM }, this.fs);
    await this.fs.chmod(SHM, 0o1777);
  }

  private async ownTmp(): Promise<void> {
    const real = await this.realLayoutPath('/tmp');
    const st = real === undefined ? undefined : await this.base.lstat(real).catch(() => undefined);
    if (
      real !== undefined &&
      st?.isDirectory &&
      this.base.hasOwner &&
      !(await this.base.hasOwner(real))
    ) {
      const names = await this.base.readdir(real).catch(() => undefined);
      let removed = 0;
      let left = names === undefined ? 1 : 0;
      for (const name of names ?? []) {
        const path = joinName(real, name);
        if (await this.base.hasOwner(path)) continue;
        const failed = this.inUse(path)
          ? 'busy'
          : await this.base.rm(path, { recursive: true, force: true }).catch(String);
        if (failed === undefined) removed++;
        else left++;
      }
      if (removed > 0) {
        console.warn(`slicc-kernel users: removed ${removed} entries from /tmp that had no owner`);
      }
      if (left === 0)
        await this.base.chown?.(real, { uid: 0, gid: 0, mode: 0o1777, follow: false });
    }
    if (st?.isDirectory) await this.base.chmod(real as string, 0o1777);
  }

  private inUse(path: string): boolean {
    return [...this.openFiles].some((nodes) => nodes.holds(path)) || heldUnder(this.held, path);
  }

  private async stampLayout(): Promise<void> {
    const layout: Array<[string, number]> = [
      ...LAYOUT,
      [this.modulesDir, 0o755],
      [this.pnpmHome, 0o755],
      [`/${UNLINKED_DIR}`, 0o700],
    ];
    for (const [path, mode] of layout) {
      if (isProtected(this.prefixes, normalizePath(path))) continue;
      const real = await this.realLayoutPath(path);
      const fresh = real !== undefined && !(await this.base.hasOwner?.(real));
      if (fresh) await this.base.chown?.(real, { uid: 0, gid: 0, mode, follow: false });
    }
  }

  private async realLayoutPath(given: string): Promise<string | undefined> {
    const path = normalizePath(given);
    if (!(await this.base.exists(path))) return undefined;
    if (path === '/') return path;
    return joinName(await realDir(this.base, parentOf(path)), baseName(path));
  }

  private pnpmReady(): Promise<void> {
    if (this.pnpmMade !== undefined) return this.pnpmMade;
    const epoch = this.pnpmEpoch;
    const made = this.base
      .mkdir(this.pnpmHome, { recursive: true })
      .then(() => (this.owners ? this.stampLayout() : undefined))
      .catch(() => {
        if (this.pnpmEpoch === epoch) this.pnpmMade = undefined;
      });
    this.pnpmMade = made;
    return made;
  }

  private pnpmStale(): void {
    this.pnpmEpoch++;
    this.pnpmMade = undefined;
  }

  private mountedBy(spec: MountSpec, cred: Cred): MountSpec {
    if (!this.owners || (cred.euid === 0 && cred.egid === 0)) return spec;
    const ids = { uid: String(cred.euid), gid: String(cred.egid) };
    const options = cred.euid === 0 ? { ...ids, ...spec.options } : { ...spec.options, ...ids };
    return { ...spec, options };
  }

  private mountRoot(path: string): string {
    let root = '/';
    for (const { target } of this.mounts.list()) {
      if (target.length > root.length && (path === target || path.startsWith(`${target}/`))) {
        root = target;
      }
    }
    return root;
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
    void this.unlinked.sweep(at);
  }

  umount(target: string, detach = false): void {
    const at = normalizePath(target);
    this.mounts.umount(at, detach);
    this.pnpmStale();
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
    this.guardMount(spec.target);
    await this.permit({ op: 'mount', pid, ...spec, options: { ...spec.options } });
    await this.mountsOwn(
      this.credOf(pid),
      spec.target,
      async () => (await this.fs.stat(spec.target)).uid
    );
    const entry = await this.mount(this.mountedBy(spec, this.credOf(pid)));
    if (signal.aborted) this.umount(entry.target, true);
  }

  async mountAs(cred: Cred, spec: MountSpec): Promise<MountEntry> {
    const target = normalizePath(spec.target);
    await this.mountsOwn(cred, target, async () => (await this.fs.stat(target)).uid);
    return this.mount(this.mountedBy(spec, cred));
  }

  async umountAs(cred: Cred, target: string): Promise<void> {
    const at = normalizePath(target);
    this.guardMount(at);
    await this.mountsOwn(cred, at, async () => Number(this.mounts.mounted(at)?.options.uid));
    this.umount(at);
  }

  private async mountsOwn(cred: Cred, target: string, owner: () => Promise<unknown>) {
    const { euid } = cred;
    if (this.usersMode !== 'enforce' || euid === 0) return;
    if ((await owner().catch(() => undefined)) !== euid) {
      throw fsError('EPERM', `${target} is not the caller's to mount or unmount`);
    }
  }

  private async processUmount(pid: number, target: string, flags: number): Promise<void> {
    const call = umountCall(target, flags);
    let mounted: MountEntry | undefined;
    this.guardMount(call.target);
    for (;;) {
      mounted = this.mounts.mounted(call.target);
      await this.permit({
        op: 'umount',
        pid,
        target: call.target,
        ...(mounted ? { type: mounted.type, source: mounted.source } : {}),
      });
      if (this.mounts.mounted(call.target) === mounted) break;
    }
    await this.mountsOwn(this.credOf(pid), call.target, async () => Number(mounted?.options.uid));
    this.umount(call.target, call.detach);
  }

  async prepare(): Promise<void> {
    await this.resolvePrefixes();
    for (const dir of SHARED_DIRS) await this.base.mkdir(dir, { recursive: true });
    if (this.owners) await this.ownTmp();
    await this.mountShm();
    await this.pnpmReady();
    await this.users.ensure();
    if (this.owners) await this.stampLayout();
    if (this.owners) await this.sudoer.provision();
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

  private environment(cwd: string, extra: Record<string, string> | undefined, account: Account) {
    const env: Record<string, string> = {
      ...this.env,
      ...userEnv(account, this.pnpmHome),
      PWD: cwd,
      ...extra,
    };
    delete env[TICKET_ENV];
    return env;
  }

  private async account(user: string | number | Account | undefined): Promise<Account> {
    if (typeof user === 'object') return user;
    return (await this.terminalAccount(user)).account;
  }

  private async terminalAccount(
    user: string | number | Account | undefined
  ): Promise<{ account: Account; tty: number | undefined }> {
    if (typeof user === 'object')
      return { account: user, tty: this.owners ? await this.users.ttyGroup() : undefined };
    const found = await this.users.lookupTerminal(user ?? 0);
    if (!found) throw fsError('ENOENT', `no user ${String(user)}`);
    return found;
  }

  private identity(account: Account, tag?: string): Pick<StartRequest, 'cred' | 'umask' | 'tag'> {
    return {
      tag,
      cred: credOf(account),
      ...(account.umask !== undefined ? { umask: account.umask } : {}),
    };
  }

  fsFor(tag: string | undefined): KernelFs {
    return this.stackFor(tag).fs;
  }

  isWriter(tag: string | undefined): boolean {
    return tag !== undefined && this.prefixes.length > 0 && this.writerTags.has(tag);
  }

  private stackFor(tag: string | undefined): WriterStack {
    if (!this.isWriter(tag)) {
      return {
        fs: this.processFs,
        noLinks: this.noLinksFs,
        nodes: this.nodes,
        unlinked: this.unlinked,
        writer: false,
      };
    }
    this.writers ??= this.writerStack();
    return this.writers;
  }

  private writerStack(): WriterStack {
    const mounted = this.mounts.wrap(this.unguardedRoot);
    const fs = this.commandFs(this.rooted(mounted));
    const nodes = new VfsNodes(fs, (path) => this.released(path), this.nodes.entries);
    nodes.keepsOnDisk = true;
    this.openFiles.add(nodes);
    const unlinked = new UnlinkedKeeper(
      fs,
      { [Symbol.iterator]: () => [this.held, this.openFiles].flatMap((set) => [...set]).values() },
      (path) => this.mountRoot(path),
      {
        locks: webLocks(),
        busy: (path) => [...this.openFiles].some((open) => open.holds(path)),
        owner: this.unlinkOwnerOption,
        ...(this.owners ? { dirOwner: { uid: 0, gid: 0, mode: 0o700 } } : {}),
      }
    );
    const noLinks = this.commandFs(this.rooted(this.noLinksOf(mounted)));
    return {
      fs: this.processChain(fs, nodes, unlinked),
      noLinks: this.processChain(noLinks, nodes, unlinked),
      nodes,
      unlinked,
      writer: true,
    };
  }

  private noLinksOf(mounted: KernelFs): KernelFs {
    return (mounted.noLinks as () => KernelFs).call(mounted);
  }

  private rooted(mounted: KernelFs): KernelFs {
    const watched = this.watchers.wrap(mounted);
    return this.owners ? this.freshModules.wrap(watched) : watched;
  }

  private commandFs(root: KernelFs): KernelFs {
    return withCommandDirs(
      root,
      async () => new Set((await this.commands()).keys()),
      (dir) => this.userCommandDir(dir),
      this.owners
    );
  }

  private processChain(fs: KernelFs, nodes: VfsNodes, unlinked: UnlinkedKeeper): KernelFs {
    nodes.changed = (path) => this.changes.publish(path);
    return unlinked.wrap(keepingOpen(fs, nodes, (path) => this.changes.publish(path)));
  }

  private async starting(argv: string[], dir: string | undefined, account: Account, tag?: string) {
    this.resetCatalogs();
    const scope = account.uid === 0 ? '' : pnpmHomeOf(account, this.pnpmHome);
    const start = dir ?? '/';
    const cwd = await physicalPathAsync(this.base, start.startsWith('/') ? start : `/${start}`);
    const file = await this.execFile(argv[0] ?? '', cwd, this.execGuard(credOf(account), 0, tag));
    if (!(await this.base.exists(cwd))) await this.stackFor(tag).fs.mkdir(cwd, { recursive: true });
    const planned = await this.plan(file, argv, cwd, scope);
    await this.mayExec(credOf(account), { file, cwd, pid: 0, tag }, planned);
    return { cwd, file, planned };
  }

  async openTerminal(argv: string[], options: TerminalOptions): Promise<TerminalSession> {
    tagOption(options.tag);
    const { account, tty: ttyGroup } = await this.terminalAccount(options.user);
    const { cwd, file, planned } = await this.starting(argv, options.cwd, account, options.tag);
    if (!planned) throw new Error(`${file}: command not found`);
    let leader = 0;
    const tty: KernelTty = new KernelTty(
      { write: (bytes) => options.onData(bytes.slice()) },
      (sig) => this.keySignal(tty, leader, sig, () => this.jobs.signalForeground(tty, leader, sig))
    );
    tty.onRead = () => this.settling.reading(this.jobs.tcgetpgrp(tty, leader));
    tty.name = `/dev/tty${++this.terminals}`;
    if (this.owners) tty.owner = { uid: account.uid, gid: ttyGroup ?? account.gid, mode: TTY_MODE };
    tty.setSize(options.cols ?? 80, options.rows ?? 24);
    const fds = new FdTable();
    const stdio = tty.file();
    fds.installAt(0, stdio);
    fds.installAt(1, stdio.retain());
    fds.installAt(2, stdio.retain());
    const env = this.environment(
      cwd,
      {
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ...options.env,
      },
      account
    );
    const report = (message: string) => options.onData(encoder.encode(`${message}\r\n`));
    const handle = await this.launch(planned, {
      env,
      cwd,
      fds,
      report,
      ...this.identity(account, options.tag),
    });
    leader = handle.pid;
    void handle.exited.then(() => tty.hangup());
    return {
      pid: handle.pid,
      exited: handle.exited,
      termsig: () => handle.termsig(),
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
    tagOption(options.tag);
    const account = await this.account(options.user);
    const { cwd, file, planned } = await this.starting(argv, options.cwd, account, options.tag);
    const env = this.environment(cwd, options.env, account);
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
      const directory = await this.directory(file, this.fs.resolvePath(cwd, file));
      report(`${file}: ${directory ? 'Is a directory' : 'command not found'}`);
      const status = directory ? NOT_EXECUTABLE : NOT_FOUND;
      return { status, stdout: concat(out), stderr: concat(err) };
    }
    const fds = new FdTable();
    fds.installAt(0, options.stdin ? bytesSource(options.stdin) : deviceFile('null'));
    fds.installAt(1, sinkFile(stdout));
    fds.installAt(2, sinkFile(stderr));
    const group = options.pgid !== undefined ? { pgid: options.pgid } : {};
    const handle = await this.launch(planned, {
      env,
      cwd,
      fds,
      report,
      ...group,
      ...this.identity(account, options.tag),
    });
    options.onStarted?.(handle.pid);
    const status = await handle.exited;
    const signal = handle.termsig();
    return { status, ...(signal ? { signal } : {}), stdout: concat(out), stderr: concat(err) };
  }
}

export type { ProcessInfo, ProcessListing } from './kernel/proc-info.ts';
