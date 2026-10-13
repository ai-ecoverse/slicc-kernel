import { type CaptureControl, type ChildStdio, type ChildTable, SpawnError } from './children.ts';
import { KernelError } from './fd-table.ts';
import { isSignal } from './signals.ts';

export type RunStdio = 'pipe' | 'ignore' | 'inherit' | number;

export type RunStderr = RunStdio | 'stdout';

export interface RunRequest {
  op: 'proc-run';
  file: string;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  pgid?: number;
  session?: true;
  stdin: RunStdio;
  input?: Uint8Array;
  stdout: RunStdio;
  stderr: RunStderr;
  maxBuffer?: number;
  timeoutMs?: number;
  killSignal: number;
}

export interface RunOutcome {
  pid: number;
  status: number | null;
  signal?: number;
  error?: { code: string };
  out: number;
  err: number;
}

export const RUN_CAPTURE_CAP = 64 * 1024 * 1024;
export const RUN_MAX_BUFFER = 1024 * 1024;

export interface RunDeps {
  children: ChildTable;
  kill(pid: number, sig: number): Promise<unknown> | unknown;
  interrupt(): AbortSignal;
  dying(): boolean;
}

function capLimit(maxBuffer: unknown): number {
  const asked = typeof maxBuffer === 'number' && maxBuffer >= 0 ? maxBuffer : RUN_MAX_BUFFER;
  return Math.min(asked, RUN_CAPTURE_CAP);
}

function slot(how: RunStderr, n: number, extra: () => ChildStdio): ChildStdio {
  if (how === 'stdout') return { sameAs: 1 };
  if (typeof how === 'number') return { fd: how };
  if (how === 'inherit') return { fd: n };
  if (how === 'ignore') return { none: true };
  return extra();
}

function frame(outcome: RunOutcome, out: Uint8Array, err: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(outcome));
  const bytes = new Uint8Array(4 + head.length + out.length + err.length);
  new DataView(bytes.buffer).setUint32(0, head.length, true);
  bytes.set(head, 4);
  bytes.set(out, 4 + head.length);
  bytes.set(err, 4 + head.length + out.length);
  return bytes;
}

async function reaped(deps: RunDeps, pid: number): Promise<number> {
  for (;;) {
    try {
      return (await deps.children.wait(pid, false, deps.interrupt()))[1];
    } catch (e) {
      if (!(e instanceof KernelError && e.code === 'EINTR') || deps.dying()) throw e;
    }
  }
}

export async function runChild(req: RunRequest, deps: RunDeps): Promise<Uint8Array> {
  if (!isSignal(req.killSignal)) throw new KernelError('EINVAL');
  const max = capLimit(req.maxBuffer);
  let failure: string | undefined;
  let pid = 0;
  const kill = () => void Promise.allSettled([deps.kill(pid, req.killSignal)]);
  const stop = (code: string) => {
    if (failure !== undefined) return;
    failure = code;
    if (pid !== 0) kill();
    decided.resolve();
  };
  const controls: Array<CaptureControl & { eof: Promise<void> }> = [];
  const capture = (): ChildStdio => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const control = { shut: false, ended: resolve, eof: promise };
    controls.push(control);
    return { capture: true, max, overflow: () => stop('ENOBUFS'), control };
  };
  const decided = Promise.withResolvers<void>();
  const stdio: ChildStdio[] = [
    slot(req.stdin, 0, () => ({ input: req.input ?? new Uint8Array(0) })),
    slot(req.stdout, 1, capture),
    slot(req.stderr, 2, capture),
  ];
  try {
    pid = await deps.children.spawn(
      {
        file: req.file,
        argv: req.argv,
        env: req.env,
        cwd: req.cwd,
        ...(req.pgid !== undefined ? { pgid: req.pgid } : {}),
        ...(req.session ? { session: req.session } : {}),
      },
      stdio
    );
  } catch (e) {
    if (!(e instanceof SpawnError)) throw e;
    const outcome = { pid: 0, status: null, error: { code: e.code }, out: 0, err: 0 };
    return frame(outcome, new Uint8Array(0), new Uint8Array(0));
  }
  if (failure !== undefined) kill();
  const timer =
    req.timeoutMs !== undefined && req.timeoutMs > 0
      ? setTimeout(() => stop('ETIMEDOUT'), req.timeoutMs)
      : undefined;
  let status: number;
  try {
    status = await reaped(deps, pid);
    const open = controls.filter((c) => c.opened);
    await Promise.race([Promise.all(open.map((c) => c.eof)), decided.promise]);
  } finally {
    clearTimeout(timer);
    for (const control of controls) control.shut = true;
  }
  const out = deps.children.captured(pid, 1);
  const err = deps.children.captured(pid, 2);
  const termsig = status & 0x7f;
  const outcome: RunOutcome = {
    pid,
    status: termsig ? null : (status >> 8) & 0xff,
    ...(termsig ? { signal: termsig } : {}),
    ...(failure !== undefined ? { error: { code: failure } } : {}),
    out: out.length,
    err: err.length,
  };
  return frame(outcome, out, err);
}
