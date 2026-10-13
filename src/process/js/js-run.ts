import { argv0Of, groupOf } from './js-children.ts';
import { JsCallError } from './js-kernel.ts';
import type { JsSyncKernel } from './js-sync.ts';

export type JsRunStdio = 'pipe' | 'ignore' | 'inherit' | number;

export interface JsRunOptions {
  argv: readonly string[];
  argv0?: string;
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  pgid?: number;
  session?: boolean;
  input?: Uint8Array | string;
  stdin?: JsRunStdio;
  stdout?: JsRunStdio;
  stderr?: JsRunStdio | 'stdout';
  maxBuffer?: number;
  timeout?: number;
  killSignal?: number | `SIG${string}`;
}

export interface JsRunResult {
  pid: number;
  status: number | null;
  signal?: number;
  stdout?: Uint8Array;
  stderr?: Uint8Array;
  error?: { code: string };
}

export interface RunDefaults {
  env: Readonly<Record<string, string>>;
  cwd: string;
  resolve(path: string): string;
  signal(name: number | `SIG${string}`): number;
}

interface Outcome {
  pid: number;
  status: number | null;
  signal?: number;
  error?: { code: string };
  out: number;
  err: number;
}

const encoder = new TextEncoder();

const STDIO = new Set<unknown>(['pipe', 'ignore', 'inherit']);

function stdioOf(how: JsRunStdio | undefined): JsRunStdio {
  if (how === undefined) return 'pipe';
  if (typeof how === 'number' && Number.isInteger(how) && how >= 0) return how;
  if (!STDIO.has(how)) throw new JsCallError('EINVAL', 'run');
  return how;
}

function stderrOf(how: JsRunStdio | 'stdout' | undefined): JsRunStdio | 'stdout' {
  return how === 'stdout' ? how : stdioOf(how);
}

function limit(value: number | undefined): number | undefined {
  if (value === undefined || value === Number.POSITIVE_INFINITY) return value;
  if (!(value >= 0)) throw new JsCallError('EINVAL', 'run');
  return value;
}

export function decodeRun(
  bytes: Uint8Array,
  stdout: JsRunStdio,
  stderr: JsRunStdio | 'stdout'
): JsRunResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(0, true);
  const outcome = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + size))) as Outcome;
  const out = bytes.slice(4 + size, 4 + size + outcome.out);
  const err = bytes.slice(4 + size + outcome.out, 4 + size + outcome.out + outcome.err);
  return {
    pid: outcome.pid,
    status: outcome.status,
    ...(outcome.signal !== undefined ? { signal: outcome.signal } : {}),
    ...(stdout === 'pipe' ? { stdout: out } : {}),
    ...(stderr === 'pipe' ? { stderr: err } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  };
}

export function runSync(kernel: JsSyncKernel, d: RunDefaults, o: JsRunOptions): JsRunResult {
  const [file] = o.argv;
  if (file === undefined) throw new JsCallError('EINVAL', 'run');
  const group = groupOf(o, 'run');
  const named = argv0Of(o.argv0, 'run');
  const stdout = stdioOf(o.stdout);
  const stderr = stderrOf(o.stderr);
  const input = typeof o.input === 'string' ? encoder.encode(o.input) : o.input;
  const maxBuffer = limit(o.maxBuffer);
  const timeout = limit(o.timeout);
  const bytes = kernel.bytes({
    op: 'proc-run',
    file,
    argv: [...o.argv],
    ...named,
    env: { ...(o.env ?? d.env) },
    cwd: o.cwd === undefined ? d.cwd : d.resolve(o.cwd),
    ...group,
    stdin: stdioOf(o.stdin),
    ...(input ? { input } : {}),
    stdout,
    stderr,
    ...(maxBuffer !== undefined && maxBuffer !== Number.POSITIVE_INFINITY ? { maxBuffer } : {}),
    ...(maxBuffer === Number.POSITIVE_INFINITY ? { maxBuffer: Number.MAX_SAFE_INTEGER } : {}),
    ...(timeout !== undefined && timeout !== Number.POSITIVE_INFINITY
      ? { timeoutMs: timeout }
      : {}),
    killSignal: d.signal(o.killSignal ?? 'SIGTERM'),
  });
  return decodeRun(bytes, stdout, stderr);
}
