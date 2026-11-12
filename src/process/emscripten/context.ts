import type { WasmSyscall } from '../../kernel/process.ts';
import type { WasmProcessInitMsg } from '../../kernel/protocol.ts';
import type { SyncSabTransport } from '../../realm/sync-sab-bridge.ts';
import type { ProcessSys } from '../kernel-streams.ts';
import type { LockKernel } from '../process-locks.ts';
import type { PtyKernel } from '../process-pty.ts';
import type { SignalGate } from '../process-signals.ts';
import type { WasiHost } from '../wasi/wasi-host.ts';
import type { WasiMemory } from '../wasi/wasi-memory.ts';
import type { EmCwd } from './cwd.ts';
import type { Reentry, WasmExport } from './reentry.ts';

export type Kernel = ProcessSys & PtyKernel & LockKernel;

export interface EmExports {
  memory: WebAssembly.Memory;
  __indirect_function_table?: WebAssembly.Table;
  malloc?: (size: number) => number;
  free?: (ptr: number) => void;
  setThrew?: (threw: number, value: number) => void;
  _emscripten_stack_restore?: (sp: number) => void;
  _emscripten_stack_alloc?: (size: number) => number;
  emscripten_stack_get_current?: () => number;
  emscripten_builtin_memalign?: (alignment: number, size: number) => number;
  slicc_sig_mask?: (which: number) => number;
  asyncify_start_unwind?: (data: number) => void;
  asyncify_stop_unwind?: () => void;
  asyncify_start_rewind?: (data: number) => void;
  asyncify_stop_rewind?: () => void;
  asyncify_get_state?: () => number;
  [name: string]: unknown;
}

export interface EmContext {
  readonly init: WasmProcessInitMsg;
  readonly host: WasiHost;
  readonly mem: WasiMemory;
  readonly sys: Kernel;
  readonly transport: SyncSabTransport;
  readonly gate: SignalGate;
  readonly cwd: EmCwd;
  readonly reentry: Reentry;
  readonly pid: number;
  ppid: number;
  call(req: WasmSyscall): unknown;
  exports(): EmExports;
  enter(name: string, fn: WasmExport, args: readonly unknown[]): unknown;
  exit(status: number): never;
  say(text: string): void;
}
