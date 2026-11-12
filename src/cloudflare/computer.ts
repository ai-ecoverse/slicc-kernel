import { attachKernel, type KernelClient, type SpawnedProcess } from '../client/attach.ts';
import type { MessagePortLike } from '../client/protocol.ts';
import { SIG } from '../kernel/signals.ts';
import { inProcessMount } from '../mount/in-process.ts';
import type { MountSpec } from '../mount/mount-fs.ts';
import {
  type WorkspaceDriver,
  type WorkspaceFilesystemLike,
  workspaceDriver,
} from './computer-driver.ts';

export type {
  WorkspaceDirentLike,
  WorkspaceDriver,
  WorkspaceDriverOptions,
  WorkspaceFilesystemLike,
  WorkspaceStatLike,
} from './computer-driver.ts';
export { workspaceDriver };

export type KillSignalName = 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP';

export type ExecEvent =
  | { id: string; seq: number; name: 'stdout'; value: Uint8Array }
  | { id: string; seq: number; name: 'stderr'; value: Uint8Array }
  | { id: string; seq: number; name: 'exit'; code: number; result?: unknown };

export interface ShellExecInput {
  source: string;
  cwd?: string;
  id?: string;
  input?: unknown;
  timeoutMs?: number;
  env?: Record<string, string>;
  stdin?: Uint8Array;
}

export interface ShellRPC {
  exec(input: ShellExecInput): Promise<{ id: string; events: ReadableStream<ExecEvent> }>;
  getExec(input: {
    id: string;
    after?: number | 'tail';
  }): Promise<{ id: string; events: ReadableStream<ExecEvent> }>;
  killExec(input: { id: string; signal?: KillSignalName }): Promise<void>;
  disposeExec(input: { id: string }): Promise<void>;
}

export interface NoSyncRPC {
  push(): never;
  fetchChanges(): never;
  watermarks(): never;
  readEntry(): never;
  hasObjects(): never;
  fetchObjects(): ReadableStream<never>;
  pushObjects(): never;
}

export interface SliccBackendHandle {
  rpc: { sync: NoSyncRPC; shell: ShellRPC };
  runtimeId: string;
  sync: 'none';
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface SliccKernelLike {
  mount(spec: MountSpec): Promise<unknown>;
  umount(target: string): Promise<void>;
  connect(options?: { user?: string | number; tag?: string }): Promise<MessagePortLike>;
}

export interface SliccBackendHost {
  readonly fs: WorkspaceFilesystemLike;
}

export interface SliccBackendOptions {
  kernel(): SliccKernelLike | Promise<SliccKernelLike>;
  id?: string;
  description?: string;
  mountPoint?: string;
  root?: string;
  type?: string;
  shell?: readonly string[];
  user?: string | number;
  timeoutMs?: number;
  killGraceMs?: number;
  retentionMs?: number;
  logBytes?: number;
}

export interface SliccBackend {
  readonly id: string;
  readonly type: 'slicc-kernel';
  readonly callable: false;
  readonly description: string;
  connect(host: SliccBackendHost): Promise<SliccBackendHandle>;
}

const DEFAULT_TIMEOUT_MS = 320_000;
const KILL_GRACE_MS = 5_000;
const RETENTION_MS = 5 * 60 * 1000;
const LOG_BYTES = 4 * 1024 * 1024;
const HARD_LOG_FACTOR = 4;

function coded(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function unref<T>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

function exitCodeOf(status: number, signal: string | undefined): number {
  if (signal === undefined) return status;
  const number = (SIG as Record<string, number>)[signal.replace(/^SIG/, '')];
  return number === undefined ? status : 128 + number;
}

const sizeOf = (event: ExecEvent) => (event.name === 'exit' ? 0 : event.value.byteLength);

class Run {
  readonly id: string;
  private events: ExecEvent[] = [];
  private first = 1;
  private seq = 0;
  private bytes = 0;
  private waiters = new Set<() => void>();
  private readers = new Set<{ cursor: number }>();
  exited = false;
  process: SpawnedProcess | undefined;
  timers: ReturnType<typeof setTimeout>[] = [];
  private readonly logBytes: number;

  constructor(id: string, logBytes: number) {
    this.id = id;
    this.logBytes = logBytes;
  }

  private add(event: ExecEvent): void {
    this.events.push(event);
    this.bytes += sizeOf(event);
    const floor = Math.min(...[...this.readers].map((reader) => reader.cursor));
    while (
      this.bytes > this.logBytes &&
      this.events.length > 1 &&
      ((this.events[0] as ExecEvent).seq <= floor || this.bytes > this.logBytes * HARD_LOG_FACTOR)
    ) {
      this.bytes -= sizeOf(this.events.shift() as ExecEvent);
      this.first++;
    }
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  output(name: 'stdout' | 'stderr', value: Uint8Array): void {
    if (this.exited || value.byteLength === 0) return;
    this.add({ id: this.id, seq: ++this.seq, name, value });
  }

  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const timer of this.timers.splice(0)) clearTimeout(timer);
    this.add({ id: this.id, seq: ++this.seq, name: 'exit', code });
  }

  stream(after: number | 'tail'): ReadableStream<ExecEvent> {
    const reader = { cursor: after === 'tail' ? this.seq : Math.max(0, after) };
    if (reader.cursor < this.first - 1) {
      throw coded(
        'ELOG_TRUNCATED',
        `the log of ${this.id} no longer reaches seq ${reader.cursor + 1}`
      );
    }
    this.readers.add(reader);
    const done = () => {
      this.readers.delete(reader);
    };
    return new ReadableStream<ExecEvent>(
      {
        pull: async (controller) => {
          for (;;) {
            if (reader.cursor < this.first - 1) {
              done();
              controller.error(coded('ELOG_TRUNCATED', `the reader of ${this.id} fell behind`));
              return;
            }
            const start = reader.cursor - this.first + 1;
            if (start < this.events.length) {
              for (const event of this.events.slice(start)) controller.enqueue(event);
              reader.cursor = this.seq;
              return;
            }
            if (this.exited) {
              done();
              controller.close();
              return;
            }
            await new Promise<void>((resolve) => this.waiters.add(resolve));
          }
        },
        cancel: done,
      },
      { highWaterMark: 0 }
    );
  }
}

function refusingSync(): NoSyncRPC {
  const refuse = (name: string): never => {
    throw new Error(
      `sliccBackend: sync.${name} is not available, the handle declares sync: "none"`
    );
  };
  return {
    push: () => refuse('push'),
    fetchChanges: () => refuse('fetchChanges'),
    watermarks: () => refuse('watermarks'),
    readEntry: () => refuse('readEntry'),
    hasObjects: () => refuse('hasObjects'),
    fetchObjects: () =>
      new ReadableStream<never>({
        start: (controller) => controller.error(new Error('sliccBackend: sync.fetchObjects')),
      }),
    pushObjects: () => refuse('pushObjects'),
  };
}

function shellFor(
  client: KernelClient,
  driver: WorkspaceDriver,
  options: SliccBackendOptions,
  mountPoint: string
): ShellRPC & { closeAll(): Promise<void> } {
  const runs = new Map<string, Run>();
  const shell = options.shell ?? ['bash', '-c'];
  const grace = options.killGraceMs ?? KILL_GRACE_MS;
  const retention = options.retentionMs ?? RETENTION_MS;
  const logBytes = options.logBytes ?? LOG_BYTES;

  const known = (id: string): Run => {
    const run = runs.get(id);
    if (!run) throw coded('ENOENT', `no exec record for id ${id}`);
    return run;
  };

  const signal = async (run: Run, name: KillSignalName) => {
    if (run.exited || !run.process) return;
    await run.process.signal(name).catch(() => undefined);
  };

  const forget = (run: Run) => {
    if (runs.get(run.id) === run) runs.delete(run.id);
  };

  async function start(run: Run, input: ShellExecInput): Promise<void> {
    const encoder = new TextEncoder();
    try {
      run.process = await client.spawn([...shell, input.source], {
        cwd: input.cwd ?? mountPoint,
        cwdMissing: 'error',
        ...(input.env ? { env: input.env } : {}),
        ...(options.user !== undefined ? { user: options.user } : {}),
        stdin: input.stdin ?? new Uint8Array(0),
        onStdout: (bytes) => run.output('stdout', bytes),
        onStderr: (bytes) => run.output('stderr', bytes),
      });
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      run.output('stderr', encoder.encode(`${err instanceof Error ? err.message : String(err)}\n`));
      run.exit(code === 'ENOENT' ? 127 : 126);
      unref(setTimeout(() => forget(run), retention));
      return;
    }
    const timeoutMs = input.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (timeoutMs > 0) {
      run.timers.push(
        unref(
          setTimeout(() => {
            void signal(run, 'SIGTERM');
            run.timers.push(unref(setTimeout(() => void signal(run, 'SIGKILL'), grace)));
          }, timeoutMs)
        )
      );
    }
    void run.process.ended.then(
      async ({ status, signal: by }) => {
        await driver.settled().catch(() => undefined);
        run.exit(exitCodeOf(status, by));
        unref(setTimeout(() => forget(run), retention));
      },
      async (err: unknown) => {
        run.output(
          'stderr',
          encoder.encode(`${err instanceof Error ? err.message : String(err)}\n`)
        );
        run.exit(-1);
        unref(setTimeout(() => forget(run), retention));
      }
    );
  }

  return {
    async exec(input) {
      const id = input.id ?? crypto.randomUUID();
      const previous = runs.get(id);
      if (previous && !previous.exited) throw coded('EEXEC_BUSY', `exec ${id} is still running`);
      const run = new Run(id, logBytes);
      runs.set(id, run);
      const events = run.stream(0);
      await start(run, input);
      return { id, events };
    },
    async getExec({ id, after }) {
      return { id, events: known(id).stream(after ?? 0) };
    },
    async killExec({ id, signal: name }) {
      await signal(known(id), name ?? 'SIGTERM');
    },
    async disposeExec({ id }) {
      const run = runs.get(id);
      if (!run) return;
      runs.delete(id);
      await signal(run, 'SIGKILL');
    },
    async closeAll() {
      const live = [...runs.values()].filter((run) => !run.exited);
      await Promise.all(live.map((run) => signal(run, 'SIGKILL')));
      await Promise.all(
        live.map((run) =>
          run.process?.ended.then(
            () => undefined,
            () => undefined
          )
        )
      );
      runs.clear();
    },
  };
}

export function sliccBackend(options: SliccBackendOptions): SliccBackend {
  const mountPoint = (options.mountPoint ?? '/workspace').replace(/\/+$/, '') || '/';
  const root = options.root ?? mountPoint;
  return {
    id: options.id ?? 'slicc',
    type: 'slicc-kernel',
    callable: false,
    description:
      options.description ??
      `Runs the source with GNU bash in the SLICC kernel, with the packages installed in it, on the Workspace files at ${mountPoint}.`,
    async connect(host) {
      const kernel = await options.kernel();
      const driver = workspaceDriver(host.fs, { root });
      const client = await attachKernel(
        await kernel.connect(options.user !== undefined ? { user: options.user } : {}),
        { locks: null }
      );
      try {
        if (mountPoint !== '/') await client.fs.mkdir(mountPoint);
        await kernel.mount(
          inProcessMount(
            { type: options.type ?? 'workspace', source: `workspace:${root}`, target: mountPoint },
            { handlers: driver, capabilities: driver.capabilities }
          )
        );
      } catch (err) {
        await client.close();
        throw err;
      }
      const shell = shellFor(client, driver, options, mountPoint);
      let closing: Promise<void> | undefined;
      return {
        rpc: { sync: refusingSync(), shell },
        runtimeId: crypto.randomUUID(),
        sync: 'none',
        closed: client.closed.then(() => undefined),
        close() {
          closing ??= (async () => {
            await shell.closeAll();
            await driver.settled().catch(() => undefined);
            await kernel.umount(mountPoint).catch(() => undefined);
            await client.close();
          })();
          return closing;
        },
      };
    },
  };
}
