import { JsCallError, type JsKernel } from './js-kernel.ts';

export type JsStdio = 'inherit' | 'pipe' | 'null' | number;

export interface JsSpawnOptions {
  argv: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
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

export function childOps(kernel: JsKernel, io: ChildIo, defaults: ChildDefaults) {
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

  const spawn = async (o: JsSpawnOptions): Promise<JsChild> => {
    const [file] = o.argv;
    if (file === undefined) throw new JsCallError('EINVAL', 'spawn');
    const mine: Array<number | undefined> = [];
    const theirs: number[] = [];
    try {
      const stdio = await slots(kernel, o, mine, theirs);
      const pid = (await kernel.json({
        op: 'proc-spawn',
        file,
        argv: [...o.argv],
        env: { ...(o.env ?? defaults.env) },
        cwd: o.cwd ?? defaults.cwd,
        stdio,
      })) as number;
      return childOf(pid, mine);
    } catch (err) {
      await closeAll(io, mine);
      throw err;
    } finally {
      await closeAll(io, theirs);
    }
  };

  return { spawn, wait, kill };
}

async function closeAll(io: ChildIo, fds: ReadonlyArray<number | undefined>): Promise<void> {
  for (const fd of fds) if (fd !== undefined) await io.close(fd).catch(() => undefined);
}

async function preflight(kernel: JsKernel, hows: readonly JsStdio[]): Promise<void> {
  for (const [n, how] of hows.entries()) {
    if (how === 'pipe' || how === 'null') continue;
    if (how !== 'inherit' && typeof how !== 'number') throw new JsCallError('EINVAL', 'spawn');
    await kernel.json({ op: 'fd-info', fd: how === 'inherit' ? n : how });
  }
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
    if (how === 'inherit') stdio.push({ fd: n });
    else if (how === 'null') stdio.push({ none: true });
    else if (typeof how === 'number') stdio.push({ fd: how });
    else {
      const [read, write] = (await kernel.json({ op: 'fd-pipe' })) as [number, number];
      mine[n] = n === 0 ? write : read;
      theirs.push(n === 0 ? read : write);
      stdio.push({ fd: n === 0 ? read : write });
    }
  }
  return stdio;
}
