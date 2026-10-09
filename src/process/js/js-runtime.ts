import type { JsProcessInitMsg } from '../../kernel/protocol.ts';
import type { SabPostLike } from '../../realm/sync-sab-bridge.ts';
import { importSource } from '../wasi/wasi-imports.ts';
import { createAsyncSabTransport, type WaitAsyncLike } from './async-sab.ts';
import { createContext, JsExit, type JsProgramContext } from './js-context.ts';
import { JsKernel } from './js-kernel.ts';
import { lockdown } from './lockdown.ts';

export type JsMain = (ctx: JsProgramContext) => unknown;

export interface JsRuntimeDeps {
  waitAsync?: WaitAsyncLike;
  load?: (source: string) => Promise<Record<string, unknown>>;
  lockdown?: () => void;
  scope?: object;
}

const NOT_RUNNABLE = 126;

interface StrayScope {
  process?: { on?: (event: string, listener: (err: unknown) => void) => void };
  addEventListener?: (
    type: string,
    listener: (event: { preventDefault(): void; reason?: unknown; error?: unknown }) => void
  ) => void;
}

export function trapStrays(scope: StrayScope, fail: (err: unknown) => void): void {
  if (typeof scope.process?.on === 'function') {
    scope.process.on('unhandledRejection', fail);
    scope.process.on('uncaughtException', fail);
    return;
  }
  scope.addEventListener?.('unhandledrejection', (event) => {
    event.preventDefault();
    fail(event.reason);
  });
  scope.addEventListener?.('error', (event) => {
    event.preventDefault();
    fail(event.error);
  });
}

async function settledStrays(): Promise<void> {
  for (let turn = 0; turn < 2; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function statusOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) ? value & 0xff : 0;
}

export function mainOf(module: Record<string, unknown>): JsMain | undefined {
  const main = typeof module.default === 'function' ? module.default : module.main;
  return typeof main === 'function' ? (main as JsMain) : undefined;
}

export async function runJsProcess(
  init: JsProcessInitMsg,
  port: SabPostLike,
  deps: JsRuntimeDeps = {}
): Promise<number> {
  const transport = createAsyncSabTransport(init.sab, port, deps.waitAsync);
  let resolveExit!: (status: number) => void;
  const exit = new Promise<number>((resolve) => (resolveExit = resolve));
  let exitedWith: number | undefined;
  const exited = (status: number): void => {
    exitedWith ??= status;
    resolveExit(status);
  };
  let failing: Promise<void> | undefined;
  const fail = (err: unknown): void => {
    if (err instanceof JsExit) return;
    failing ??= say(message(err)).then(() => exited(1));
  };
  const kernel = new JsKernel({
    sab: init.sab,
    transport,
    onError: fail,
    waitAsync: deps.waitAsync,
  });
  const { ctx, drain } = createContext({
    kernel,
    argv: [init.argv0, ...init.args],
    env: init.env,
    pid: init.pid,
    cwd: init.cwd,
    exit: (status) => exited(statusOf(status)),
  });
  const say = (text: string) => ctx.write(2, `${init.argv0}: ${text}\n`).catch(() => undefined);

  let main: JsMain | undefined;
  trapStrays((deps.scope ?? globalThis) as StrayScope, fail);
  try {
    (deps.lockdown ?? lockdown)();
    main = mainOf(await (deps.load ?? importSource)(init.program.glue));
  } catch (err) {
    await say(message(err));
    return NOT_RUNNABLE;
  }
  if (!main) {
    await say(`${init.program.path} exports no main function`);
    return NOT_RUNNABLE;
  }
  const program = main;
  const ran = Promise.resolve()
    .then(() => program(ctx))
    .then(statusOf, async (err: unknown) => {
      if (err instanceof JsExit) return err.status;
      await say(message(err));
      return 1;
    });
  const status = await Promise.race([ran, exit]);
  await drain();
  await settledStrays();
  await failing;
  if (exitedWith !== undefined) return exitedWith;
  return status;
}
