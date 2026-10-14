import type { SyncFsResult } from '../../realm/sync-fs-wire.ts';
import type { SyncSabRequestBody } from '../../realm/sync-sab-wire.ts';
import { JsCallError, type JsKernel } from './js-kernel.ts';

export interface SyncSpawnKernel {
  json(req: SyncSabRequestBody): unknown;
  raw(req: SyncSabRequestBody): SyncFsResult;
}

export type JsStdio = 'inherit' | 'pipe' | 'null' | number;

export interface JsSpawnOptions {
  argv: readonly string[];
  argv0?: string;
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  pgid?: number;
  session?: boolean;
  stdin?: JsStdio;
  stdout?: JsStdio;
  stderr?: JsStdio;
}

export interface JsExited {
  status: number;
  signal?: number;
}

export interface JsChild {
  readonly pid: number;
  readonly stdin?: WritableStream<Uint8Array>;
  readonly stdout?: ReadableStream<Uint8Array>;
  readonly stderr?: ReadableStream<Uint8Array>;
  wait(): Promise<JsExited>;
  kill(signal?: number | `SIG${string}`): Promise<void>;
}

export interface ChildIo {
  read(fd: number, max: number | undefined, signal: AbortSignal): Promise<Uint8Array>;
  send(fd: number, data: Uint8Array, signal: AbortSignal): Promise<void>;
  close(fd: number): Promise<void>;
}

export interface ChildDefaults {
  env: Readonly<Record<string, string>>;
  cwd: string;
  signal(name: number | `SIG${string}`): number;
}

const STDIO = ['stdin', 'stdout', 'stderr'] as const;
const SIGTERM = 15;

type Slot = { fd: number } | { none: true };

export function exitedOf(status: number): JsExited {
  const signal = status & 0x7f;
  return signal ? { status: 128 + signal, signal } : { status: (status >> 8) & 0xff };
}

function readable(io: ChildIo, fd: number): ReadableStream<Uint8Array> {
  const cancelled = new AbortController();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const chunk = await io.read(fd, undefined, cancelled.signal).catch((err: unknown) => {
          if (cancelled.signal.aborted) return undefined;
          throw err;
        });
        if (chunk === undefined) return;
        if (chunk.length > 0) {
          controller.enqueue(chunk);
          return;
        }
        controller.close();
        await io.close(fd);
      },
      cancel: () => {
        cancelled.abort();
        return io.close(fd);
      },
    },
    { highWaterMark: 0 }
  );
}

function writable(io: ChildIo, fd: number): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write: (chunk, controller) => io.send(fd, chunk, controller.signal),
    close: () => io.close(fd),
    abort: () => io.close(fd),
  });
}

export function childOps(
  kernel: JsKernel,
  io: ChildIo,
  defaults: ChildDefaults,
  sync: SyncSpawnKernel
) {
  const wait = async (pid: number): Promise<JsExited> => {
    const r = await kernel.blocking({ op: 'proc-wait', pid, nohang: false });
    const [, status] = (r.ok && r.kind === 'json' ? r.json : [0, 0]) as [number, number];
    return exitedOf(status);
  };
  const kill = async (pid: number, signal: number | `SIG${string}` = SIGTERM): Promise<void> => {
    await kernel.call({ op: 'proc-kill', pid, sig: signal === 0 ? 0 : defaults.signal(signal) });
  };

  const childOf = (pid: number, mine: Array<number | undefined>): JsChild => {
    const [stdin, stdout, stderr] = mine;
    return {
      pid,
      ...(stdin !== undefined ? { stdin: writable(io, stdin) } : {}),
      ...(stdout !== undefined ? { stdout: readable(io, stdout) } : {}),
      ...(stderr !== undefined ? { stderr: readable(io, stderr) } : {}),
      wait: () => wait(pid),
      kill: (signal?: number | `SIG${string}`) => kill(pid, signal),
    };
  };

  const request = (o: JsSpawnOptions) => {
    const [file] = o.argv;
    if (file === undefined) throw new JsCallError('EINVAL', 'spawn');
    const group = groupOf(o, 'spawn');
    const named = argv0Of(o.argv0, 'spawn');
    return (stdio: Slot[]): SyncSabRequestBody => ({
      op: 'proc-spawn',
      file,
      argv: [...o.argv],
      ...named,
      env: { ...(o.env ?? defaults.env) },
      cwd: o.cwd ?? defaults.cwd,
      stdio,
      ...group,
    });
  };

  const spawnSync = (o: JsSpawnOptions): JsChild => {
    const spawning = request(o);
    const mine: Array<number | undefined> = [];
    const theirs: number[] = [];
    try {
      const stdio = slotsSync(sync, o, mine, theirs);
      return childOf(sync.json(spawning(stdio)) as number, mine);
    } catch (err) {
      closeAllSync(sync, mine);
      throw err;
    } finally {
      closeAllSync(sync, theirs);
    }
  };

  const spawn = async (o: JsSpawnOptions): Promise<JsChild> => {
    const spawning = request(o);
    const mine: Array<number | undefined> = [];
    const theirs: number[] = [];
    try {
      const stdio = await slots(kernel, o, mine, theirs);
      const pid = (await kernel.json(spawning(stdio))) as number;
      return childOf(pid, mine);
    } catch (err) {
      await closeAll(io, mine);
      throw err;
    } finally {
      await closeAll(io, theirs);
    }
  };

  return { spawn, wait, kill, spawnSync };
}

export function groupOf(
  o: { pgid?: number; session?: boolean },
  call: string
): { pgid?: number; session?: true } {
  const { pgid, session } = o;
  const valid = pgid === undefined || (Number.isInteger(pgid) && pgid >= 0);
  if (!valid || (session !== undefined && typeof session !== 'boolean')) {
    throw new JsCallError('EINVAL', call);
  }
  if (session && pgid !== undefined) throw new JsCallError('EINVAL', call);
  return session ? { session: true } : pgid !== undefined ? { pgid } : {};
}

export function argv0Of(argv0: unknown, call: string): { argv0?: string } {
  if (argv0 === undefined) return {};
  if (typeof argv0 !== 'string') throw new JsCallError('EINVAL', call);
  return { argv0 };
}

async function closeAll(io: ChildIo, fds: ReadonlyArray<number | undefined>): Promise<void> {
  for (const fd of fds) if (fd !== undefined) await io.close(fd).catch(() => undefined);
}

function closeAllSync(sync: SyncSpawnKernel, fds: ReadonlyArray<number | undefined>): void {
  for (const fd of fds) if (fd !== undefined) sync.raw({ op: 'fd-close', fd });
}

function checked(hows: readonly JsStdio[]): number[] {
  const fds: number[] = [];
  for (const [n, how] of hows.entries()) {
    if (how === 'pipe' || how === 'null') continue;
    if (how !== 'inherit' && typeof how !== 'number') throw new JsCallError('EINVAL', 'spawn');
    fds.push(how === 'inherit' ? n : how);
  }
  return fds;
}

async function preflight(kernel: JsKernel, hows: readonly JsStdio[]): Promise<void> {
  for (const fd of checked(hows)) await kernel.json({ op: 'fd-info', fd });
}

function slot(
  n: number,
  how: JsStdio,
  pipe: () => [number, number],
  mine: Array<number | undefined>,
  theirs: number[]
): Slot {
  if (how === 'inherit') return { fd: n };
  if (how === 'null') return { none: true };
  if (typeof how === 'number') return { fd: how };
  const [read, write] = pipe();
  mine[n] = n === 0 ? write : read;
  theirs.push(n === 0 ? read : write);
  return { fd: n === 0 ? read : write };
}

function slotsSync(
  sync: SyncSpawnKernel,
  o: JsSpawnOptions,
  mine: Array<number | undefined>,
  theirs: number[]
): Slot[] {
  const hows = STDIO.map((name) => o[name] ?? ('inherit' as const));
  for (const fd of checked(hows)) sync.json({ op: 'fd-info', fd });
  const pipe = () => sync.json({ op: 'fd-pipe' }) as [number, number];
  return hows.map((how, n) => slot(n, how, pipe, mine, theirs));
}

async function slots(
  kernel: JsKernel,
  o: JsSpawnOptions,
  mine: Array<number | undefined>,
  theirs: number[]
): Promise<Slot[]> {
  const hows = STDIO.map((name) => o[name] ?? ('inherit' as const));
  await preflight(kernel, hows);
  const stdio: Slot[] = [];
  for (const [n, how] of hows.entries()) {
    const pair = how === 'pipe' ? ((await kernel.json({ op: 'fd-pipe' })) as [number, number]) : [];
    stdio.push(slot(n, how, () => pair as [number, number], mine, theirs));
  }
  return stdio;
}
