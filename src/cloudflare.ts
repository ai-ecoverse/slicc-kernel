import { HOST_SOURCE, PROCESS_SOURCE } from 'slicc:cloudflare-sources';
import { remoteWorker } from './async/remote-worker.ts';
import type { MessagePortLike } from './client/protocol.ts';
import { type ServedClient, serveClient } from './client/serve-client.ts';
import { Images } from './cloudflare/images.ts';
import { ISOLATE_WAIT_MS, IsolateGate, MAX_ISOLATES } from './cloudflare/isolates.ts';
import { cloudflareProcesses, type ProcessHostCode } from './cloudflare/loader.ts';
import type { CloudflareKernel, CloudflareKernelOptions } from './cloudflare/options.ts';
import { PIECE_BYTES } from './cloudflare/rpc-pack.ts';
import { sqliteMeta } from './cloudflare/sqlite-meta.ts';
import { sqliteRoot } from './cloudflare/sqlite-root.ts';
import { OpfsFs } from './fs/opfs.ts';
import { DEFAULT_USERS, fsError, modeOption } from './fs/types.ts';
import type { ConnectOptions } from './index.ts';
import { type EmbedderHook, kindsOf } from './kernel/embedder.ts';
import { sealedHooks } from './kernel/net/sealed-fetch.ts';
import { quiet, signalField } from './kernel/signals.ts';
import { Launcher, type ModuleUrl, tagOption } from './launcher.ts';
import { isMemoryRoot, memoryRoot } from './node/memory-root.ts';
import { localPorts } from './ports.ts';
import { signalNumber } from './serve.ts';

export { attachKernel, type KernelClient } from './client/attach.ts';
export {
  type ExecEvent,
  type KillSignalName,
  type ShellExecInput,
  type SliccBackend,
  type SliccBackendHandle,
  type SliccBackendHost,
  type SliccBackendOptions,
  type SliccKernelLike,
  sliccBackend,
  type WorkspaceDirentLike,
  type WorkspaceDriver,
  type WorkspaceDriverOptions,
  type WorkspaceFilesystemLike,
  type WorkspaceStatLike,
  workspaceDriver,
} from './cloudflare/computer.ts';
export { type ImageHandle, Images } from './cloudflare/images.ts';
export { ISOLATE_WAIT_MS, IsolateGate, MAX_ISOLATES } from './cloudflare/isolates.ts';
export {
  cloudflareProcesses,
  type Processes,
  type ProcessHostCode,
  type WorkerCode,
  type WorkerLoaderLike,
} from './cloudflare/loader.ts';
export type { CloudflareKernel, CloudflareKernelOptions } from './cloudflare/options.ts';
export { sqliteMeta } from './cloudflare/sqlite-meta.ts';
export { isSqliteRoot, sqliteRoot } from './cloudflare/sqlite-root.ts';
export type { SqlCursorLike, SqliteOptions, SqlStorageLike } from './cloudflare/sqlite-store.ts';
export { memoryRoot };
export const PROCESS_HOST_SOURCE: string = HOST_SOURCE;
export const ASYNC_PROCESS_SOURCE: string | undefined = PROCESS_SOURCE;

const TERMINATED = 'the kernel is terminated';
const NO_PROCESS_HOST =
  'createCloudflareKernel: the async process host (dist/async-process.js) is not built';

function textOf(on: ((text: string) => void) | undefined) {
  if (!on) return undefined;
  const decoder = new TextDecoder();
  return (bytes: Uint8Array) => on(decoder.decode(bytes, { stream: true }));
}

function checkedRequests(hook: EmbedderHook): EmbedderHook {
  const kinds = kindsOf(hook);
  return { kinds, handle: (request) => hook.handle(request) };
}

function sourceModule(source: string): ModuleUrl {
  return { url: 'slicc-module:cloudflare', source, revoke: () => {} };
}

function hostCode(options: CloudflareKernelOptions): ProcessHostCode {
  const process = options.processHost?.process ?? PROCESS_SOURCE;
  return {
    host: options.processHost?.host ?? HOST_SOURCE,
    process: process ?? `throw new Error(${JSON.stringify(NO_PROCESS_HOST)});`,
    ...(options.processHost?.compatibilityDate
      ? { compatibilityDate: options.processHost.compatibilityDate }
      : {}),
    ...(options.processHost?.compatibilityFlags
      ? { compatibilityFlags: options.processHost.compatibilityFlags }
      : {}),
    ...(options.processHost?.localForks === false ? { localForks: false } : {}),
  };
}

function rootFs(options: CloudflareKernelOptions): { root: FileSystemDirectoryHandle; fs: OpfsFs } {
  const { sql } = options;
  if (sql && (options.root || options.meta)) {
    throw new TypeError('createCloudflareKernel: give either sql or root and meta');
  }
  const root = options.root ?? (sql ? sqliteRoot(sql, options.sqlite) : memoryRoot());
  const meta = options.meta ?? (sql ? sqliteMeta(sql, options.sqlite) : undefined);
  const ranged = options.ranged ?? (sql !== undefined || isMemoryRoot(root));
  return { root, fs: new OpfsFs(root, meta, undefined, { ranged }) };
}

let sessions = 0;

function client(
  launcher: Launcher,
  clients: Set<ServedClient>,
  { user, tag, requests }: ConnectOptions
): MessagePort {
  tagOption(tag);
  const { port1, port2 } = launcher.ports();
  const session = ++sessions;
  const served = serveClient(port1 as unknown as MessagePortLike, {
    launcher: async () => launcher,
    signal: signalNumber,
    session,
    ...(requests === 'attach' ? { attachRequests: true } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(tag !== undefined ? { tag } : {}),
  });
  clients.add(served);
  const unbind =
    requests && requests !== 'attach'
      ? launcher.embedder.register(session, checkedRequests(requests))
      : undefined;
  void served.closed.then(() => {
    clients.delete(served);
    unbind?.();
  });
  return port2;
}

export async function createCloudflareKernel(
  options: CloudflareKernelOptions
): Promise<CloudflareKernel> {
  if (!options?.loader) throw new TypeError('createCloudflareKernel: loader is required');
  const hooks = sealedHooks(options.sealed);
  const { root, fs } = rootFs(options);
  await fs.reconcile();
  const images = new Images();
  const gate = new IsolateGate(
    options.isolates?.max ?? MAX_ISOLATES,
    options.isolates?.waitMs ?? options.wasmMemories?.idleMs ?? ISOLATE_WAIT_MS
  );
  const processes = cloudflareProcesses(options.loader, images, gate, hostCode(options));
  const live = new Set<{ terminate(): void }>();
  const pending = new Set<(err: Error) => void>();
  const clients = new Set<ServedClient>();
  let terminated = false;
  const transport = options.network?.transport;
  const launcher = new Launcher({
    fs,
    moduleUrl: sourceModule,
    compile: images.compile,
    ports: localPorts,
    emscripten: 'kernel',
    admit: (program) => processes.admit(program.abi === 'js' ? undefined : program.module),
    createWorker: () => {
      const worker = remoteWorker((init) => processes.open(init), {
        maxMessageBytes: PIECE_BYTES,
        snapshot: (token, offset, max) => processes.forks.read(token, offset, max),
      });
      const tracked = {
        ...worker,
        terminate() {
          live.delete(tracked);
          worker.terminate();
        },
      };
      live.add(tracked);
      if (terminated) queueMicrotask(() => tracked.terminate());
      return tracked;
    },
    ...(options.modules ? { modules: options.modules } : {}),
    ...(options.commands ? { commands: options.commands } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(transport ? { transport } : {}),
    ...(options.network?.uplink ? { uplink: options.network.uplink } : {}),
    ...(options.network?.doh !== undefined ? { doh: options.network.doh } : {}),
    ...(options.processMounts !== undefined ? { processMounts: options.processMounts } : {}),
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    ...(options.timeZone !== undefined ? { timeZone: options.timeZone } : {}),
    users: options.users === undefined ? DEFAULT_USERS : options.users,
    ...(options.onDenial ? { onDenial: options.onDenial } : {}),
    ...(options.protect ? { protect: options.protect } : {}),
    ...(hooks.request ? { sealed: hooks.request } : {}),
    ...(hooks.fetch ? { sealedFetch: hooks.fetch } : {}),
    ...(options.requests ? { embedder: checkedRequests(options.requests) } : {}),
    ...(options.approve ? { approve: options.approve } : {}),
    ...(options.wasmMemories ? { wasmMemories: options.wasmMemories } : {}),
    ...(options.cron?.clock ? { cron: { clock: options.cron.clock } } : {}),
  });
  await launcher.prepare();
  const guard = <T>(work: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (terminated) return reject(new Error(TERMINATED));
      pending.add(reject);
      work()
        .then(resolve, reject)
        .finally(() => pending.delete(reject));
    });
  const decoder = new TextDecoder();
  return {
    root,
    images,
    isolates: gate,
    processes,
    async run(argv, opts = {}) {
      const { stdin, onStdout, onStderr, ...rest } = opts;
      const onOut = textOf(onStdout);
      const onErr = textOf(onStderr);
      const result = await guard(() =>
        launcher.run(argv, {
          ...rest,
          ...(stdin !== undefined
            ? { stdin: typeof stdin === 'string' ? new TextEncoder().encode(stdin) : stdin }
            : {}),
          ...(onOut ? { onStdout: onOut } : {}),
          ...(onErr ? { onStderr: onErr } : {}),
        })
      );
      return {
        status: result.status,
        ...signalField(result.signal),
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    },
    async openTerminal(argv, opts = {}) {
      const { onData, ...rest } = opts;
      let listener = onData ?? null;
      const backlog: Uint8Array[] = [];
      const session = await guard(() =>
        launcher.openTerminal(argv, {
          ...rest,
          onData: (bytes) => (listener ? listener(bytes) : backlog.push(bytes)),
        })
      );
      return {
        pid: session.pid,
        exited: quiet(guard(() => session.exited)),
        ended: quiet(
          guard(async () => ({ status: await session.exited, ...signalField(session.termsig()) }))
        ),
        get onData() {
          return listener;
        },
        set onData(next) {
          listener = next;
          if (next) for (const bytes of backlog.splice(0)) next(bytes);
        },
        write: (data) =>
          session.write(typeof data === 'string' ? new TextEncoder().encode(data) : data),
        resize: (cols, rows) => session.resize(cols, rows),
        signal: (name) => session.signal(signalNumber(name)),
        close: () => session.close(),
      };
    },
    async writeFile(path, data, writeOptions = {}) {
      const mode = writeOptions.mode === undefined ? undefined : modeOption(writeOptions.mode);
      const parent = path.slice(0, path.lastIndexOf('/')) || '/';
      await launcher.fs.mkdir(parent, { recursive: true });
      if (mode !== undefined) {
        await launcher.fs.writeFile(path, '');
        await launcher.fs.chmod(path, mode);
      }
      await launcher.fs.writeFile(path, data);
    },
    chmod: async (path, mode) => launcher.fs.chmod(path, modeOption(mode)),
    readFile: async (path) => launcher.fs.readFileBuffer(path),
    mount: (spec) => guard(() => launcher.mount(spec)),
    umount: (target) => guard(async () => launcher.umount(target)),
    mounts: async () => launcher.mounts.listed(),
    setRoutes: (routes) => guard(async () => launcher.setRoutes(routes)),
    users: {
      mode: launcher.usersMode,
      add: (user) => guard(() => launcher.users.add(user)),
      remove: (name, removeOptions) => guard(() => launcher.users.remove(name, removeOptions)),
      list: () => guard(() => launcher.users.list()),
    },
    groups: {
      list: () => guard(() => launcher.users.groups()),
      add: (name, groupOptions) => guard(() => launcher.users.addGroup(name, groupOptions?.gid)),
      addMember: (group, user) => guard(() => launcher.users.addMember(group, user)),
      removeMember: (group, user) => guard(() => launcher.users.removeMember(group, user)),
    },
    async connect(connectOptions = {}) {
      if (terminated) throw new Error(TERMINATED);
      const { user } = connectOptions;
      if (user !== undefined && !(await guard(() => launcher.users.lookup(user)))) {
        throw fsError('ENOENT', `no user ${String(user)}`);
      }
      return client(launcher, clients, connectOptions);
    },
    terminate() {
      terminated = true;
      for (const served of [...clients]) served.detach();
      for (const reject of [...pending]) reject(new Error(TERMINATED));
      for (const worker of [...live]) worker.terminate();
      launcher.cdp.close();
      launcher.endFills();
      launcher.unmountAll();
      processes.forks.clear();
    },
  };
}
