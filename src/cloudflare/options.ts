import type { CronClock } from '../cron/clock.ts';
import type { DenialHook } from '../fs/dac.ts';
import type { MetaStore } from '../fs/meta.ts';
import type { Protection } from '../fs/protect.ts';
import type { UsersMode } from '../fs/types.ts';
import type {
  ConnectOptions,
  KernelGroups,
  KernelUsers,
  RunOptions,
  RunResult,
  Terminal,
  TerminalOptions,
} from '../index.ts';
import type { EmbedderHook } from '../kernel/embedder.ts';
import type { RouteTable } from '../kernel/net/routes.ts';
import type { SealedOption } from '../kernel/net/sealed-fetch.ts';
import type { NetworkUplink } from '../kernel/net/uplink.ts';
import type { MountEntry, MountSpec } from '../mount/mount-fs.ts';
import type { ProcessMountPolicy } from '../mount/syscall.ts';
import type { ApproveHook } from '../sudo.ts';
import type { NetworkTransport } from '../transport.ts';
import type { Images } from './images.ts';
import type { IsolateGate } from './isolates.ts';
import type { Processes, ProcessHostCode, WorkerLoaderLike } from './loader.ts';
import type { SqliteOptions, SqlStorageLike } from './sqlite-store.ts';

export interface CloudflareKernelOptions {
  loader: WorkerLoaderLike;
  root?: FileSystemDirectoryHandle;
  meta?: MetaStore;
  ranged?: boolean;
  sql?: SqlStorageLike;
  sqlite?: SqliteOptions;
  processHost?: Partial<ProcessHostCode>;
  isolates?: { max?: number; waitMs?: number };
  modules?: string;
  commands?: { append?: readonly string[] };
  env?: Record<string, string>;
  network?: { transport?: NetworkTransport; uplink?: NetworkUplink; doh?: string | false };
  processMounts?: ProcessMountPolicy;
  hostname?: string;
  timeZone?: string;
  users?: UsersMode;
  onDenial?: DenialHook;
  sealed?: SealedOption;
  requests?: EmbedderHook;
  approve?: ApproveHook;
  protect?: Protection;
  cron?: { clock?: CronClock };
  wasmMemories?: { ceiling?: number; idleMs?: number };
}

export interface CloudflareKernel {
  readonly root: FileSystemDirectoryHandle;
  readonly images: Images;
  readonly isolates: IsolateGate;
  readonly processes: Processes;
  run(argv: string[], options?: RunOptions): Promise<RunResult>;
  openTerminal(argv: string[], options?: TerminalOptions): Promise<Terminal>;
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  chmod(path: string, mode: number): Promise<void>;
  connect(options?: ConnectOptions): Promise<MessagePort>;
  readonly users: KernelUsers;
  readonly groups: KernelGroups;
  setRoutes(routes: RouteTable): Promise<void>;
  mount(spec: MountSpec): Promise<MountEntry>;
  umount(target: string): Promise<void>;
  mounts(): Promise<MountEntry[]>;
  terminate(): void;
}
