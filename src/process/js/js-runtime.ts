import {
  JS_THREAD_NO_MEMORY,
  type JsProcessInitMsg,
  type JsThreadInitMsg,
  type JsThreadStart,
} from '../../kernel/protocol.ts';
import type { SabPostLike } from '../../realm/sync-sab-bridge.ts';
import { importSource } from '../wasi/wasi-imports.ts';
import { createAsyncSabTransport, type WaitAsyncLike } from './async-sab.ts';
import type { JsAsyncContext, JsMemory, JsPromiseProbe, JsRunScript } from './js-context.ts';
import {
  createContext,
  identityOf,
  JsExit,
  type JsProgramContext,
  type JsStrays,
} from './js-context.ts';
import { JsKernel } from './js-kernel.ts';
import { laneOf } from './js-sync.ts';
import { outOfMemory, threadContext } from './js-thread.ts';
import { lockdown } from './lockdown.ts';

export type JsMain = (ctx: JsProgramContext) => unknown;

export interface JsRuntimeDeps {
  waitAsync?: WaitAsyncLike;
  load?: (source: string) => Promise<Record<string, unknown>>;
  lockdown?: () => void;
  scope?: object;
  memory?: () => JsMemory;
  asyncContext?: () => JsAsyncContext;
  runScript?: JsRunScript;
  promiseState?: JsPromiseProbe;
  imported?: () => void;
}

const NOT_RUNNABLE = 126;

type StrayKind = keyof JsStrays;
type Stray = (kind: StrayKind, err: unknown, promise?: Promise<unknown>) => void;

interface StrayScope {
  process?: {
    on?: (event: string, listener: (err: unknown, promise?: Promise<unknown>) => void) => void;
  };
  addEventListener?: (
    type: string,
    listener: (event: {
      preventDefault(): void;
      reason?: unknown;
      error?: unknown;
      promise?: Promise<unknown>;
    }) => void
  ) => void;
}

export function trapStrays(scope: StrayScope, stray: Stray): void {
  if (typeof scope.process?.on === 'function') {
    scope.process.on('unhandledRejection', (err, promise) => stray('rejection', err, promise));
    scope.process.on('uncaughtException', (err) => stray('exception', err));
    return;
  }
  scope.addEventListener?.('unhandledrejection', (event) => {
    event.preventDefault();
    stray('rejection', event.reason, event.promise);
  });
  scope.addEventListener?.('error', (event) => {
    event.preventDefault();
    stray('exception', event.error);
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

export function runJsProcess(
  init: JsProcessInitMsg,
  port: SabPostLike,
  deps: JsRuntimeDeps = {}
): Promise<number> {
  return runJs(init, port, deps, undefined);
}

export function runJsThread(
  init: JsThreadInitMsg,
  port: SabPostLike,
  deps: JsRuntimeDeps = {}
): Promise<number> {
  const { thread, ...rest } = init;
  return runJs(rest as unknown as JsProcessInitMsg, port, deps, thread);
}

async function runJs(
  init: JsProcessInitMsg,
  port: SabPostLike,
  deps: JsRuntimeDeps,
  thread: JsThreadStart | undefined
): Promise<number> {
  const failed = (err: unknown): number => (thread && outOfMemory(err) ? JS_THREAD_NO_MEMORY : 1);
  const transport = createAsyncSabTransport(init.sab, port, deps.waitAsync);
  let resolveExit!: (status: number) => void;
  const exit = new Promise<number>((resolve) => (resolveExit = resolve));
  let exitedWith: number | undefined;
  const exited = (status: number): void => {
    exitedWith ??= status;
    resolveExit(status);
  };
  let failing: Promise<void> | undefined;
  let failedWith: number | undefined;
  const fail = (err: unknown): void => {
    if (err instanceof JsExit) return;
    failing ??= (thread ? Promise.resolve() : say(message(err))).then(() => exited(failed(err)));
    failedWith ??= failed(err);
  };
  const kernel = new JsKernel({
    sab: init.sab,
    transport,
    onError: fail,
    waitAsync: deps.waitAsync,
  });
  void kernel.watchStops();
  const strays: JsStrays = { exception: new Set(), rejection: new Set() };
  const id = identityOf(await kernel.json({ op: 'proc-identity' }), init);
  kernel.pid = id.pid;
  const { ctx, drain } = createContext({
    kernel,
    argv: [init.argv0, ...init.args],
    env: init.env,
    pid: id.pid,
    ppid: id.ppid,
    cwd: init.cwd,
    exit: (status) => exited(statusOf(status)),
    lane: laneOf(init.lane),
    fs: { owners: init.owners === true, links: init.links === true },
    strays,
    thread: threadContext(port, thread),
    memory: deps.memory,
    asyncContext: deps.asyncContext,
    runScript: deps.runScript,
    modulePath: modulePathOf(init.program),
    promiseState: deps.promiseState,
    ...(thread?.owned ? { owned: thread.owned } : {}),
    held: init.held,
    failed: () => failedWith,
  });
  const say = (text: string) => ctx.write(2, `${init.argv0}: ${text}\n`).catch(() => undefined);

  let main: JsMain | undefined;
  trapStrays((deps.scope ?? globalThis) as StrayScope, (kind, err, promise) => {
    const listeners = [...strays[kind]];
    if (listeners.length === 0) return fail(err);
    for (const listener of listeners) {
      try {
        listener(err, promise);
      } catch (thrown) {
        fail(thrown);
      }
    }
  });
  try {
    (deps.lockdown ?? lockdown)();
    const { url, glue } = init.program;
    main = mainOf(await (url ? import(url) : (deps.load ?? importSource)(glue)));
    deps.imported?.();
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
      if (!thread) await say(message(err));
      return failed(err);
    });
  const status = await Promise.race([ran, exit]);
  await drain();
  await settledStrays();
  await failing;
  if (exitedWith !== undefined) return exitedWith;
  return status;
}

function modulePathOf(program: { glue: string; path: string }): string | undefined {
  if (program.glue !== '') return undefined;
  return program.path;
}
