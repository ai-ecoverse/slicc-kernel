import type { EmContext } from './context.ts';
import { EM } from './errno.ts';
import type { WasmExport } from './reentry.ts';

const DEFAULT_STACK = 65536;

function canBlock(): boolean {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0);
    return true;
  } catch {
    return false;
  }
}

function initMainThread(ctx: EmContext, self: number): void {
  const ex = ctx.exports();
  const blocks = canBlock();
  const init = ex._emscripten_thread_init;
  if (typeof init === 'function') {
    const args = [self, blocks ? 0 : 1, 1, blocks ? 1 : 0, DEFAULT_STACK, 0];
    ctx.enter('_emscripten_thread_init', init as WasmExport, args);
  }
  const tls = ex._emscripten_tls_init;
  if (typeof tls === 'function') ctx.enter('_emscripten_tls_init', tls as WasmExport, []);
}

export function pthreadImports(ctx: EmContext): WebAssembly.ModuleImports {
  const nothing = () => {};
  return {
    _emscripten_init_main_thread_js: (self: number) => initMainThread(ctx, self),
    __pthread_create_js: () => EM.AGAIN,
    _emscripten_thread_set_strongref: nothing,
    _emscripten_thread_mailbox_await: nothing,
    _emscripten_thread_cleanup: nothing,
    _emscripten_notify_mailbox_postmessage: nothing,
    _emscripten_receive_on_main_thread_js: () => 0,
    emscripten_check_blocking_allowed: nothing,
    emscripten_exit_with_live_runtime: () => ctx.exit(0),
  };
}
