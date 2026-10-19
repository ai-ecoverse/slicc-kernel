import type { ForeignResults, ImportedMemory } from '../process/wasi/wasi-module.ts';
import type { WasiForkState } from '../process/wasi/wasix-fork.ts';
import type { LinkRecord } from '../process/wasi/wasix-linker.ts';
import type { BlockedMask } from '../realm/sync-sab-wire.ts';
import type { Cred } from './cred.ts';
import type { DeviceMeta, KernelFdKind } from './fd-table.ts';

export const WASM_PROCESS_INIT = 'wasm-process-init';
export const WASM_PROCESS_EXIT = 'wasm-process-exit';
export const WASM_PROCESS_ERROR = 'wasm-process-error';
export const WASM_PROCESS_READY = 'wasm-process-ready';
export const WASM_THREAD_SPAWN = 'wasm-thread-spawn';
export const WASM_THREAD_INIT = 'wasm-thread-init';
export const WASM_THREAD_EXIT = 'wasm-thread-exit';
export const WASM_MAX_THREADS = 256;
export const WASM_DEFAULT_THREADS = 64;
export const JS_THREAD_SPAWN = 'js-thread-spawn';
export const JS_THREAD_INIT = 'js-thread-init';
export const JS_THREAD_EXIT = 'js-thread-exit';
export const JS_MAX_THREADS = 256;
export const JS_DEFAULT_THREADS = 16;
export const JS_THREAD_NO_MEMORY = 256;
export const JS_THREAD_CRASHED = 257;
export const JS_THREAD_OWNED_FDS = 1024;

export interface WasmProgram {
  abi?: 'emscripten' | 'wasi';
  glue: string;
  module: WebAssembly.Module;
  memory?: ImportedMemory;
  foreign?: ForeignResults | undefined;
  path?: string;
  names?: string;
  imports?: string;
  preopenRoot?: boolean;
}

export interface JsProgram {
  abi: 'js';
  glue: string;
  path: string;
  url?: string;
}

export type Program = WasmProgram | JsProgram;

export interface ForkState {
  memory: Uint8Array;
  currData: number;
  forkSp: number;
  callStackNames: Array<[number, string]>;
  ppid: number;
  streams?: ForkStream[];
  cwd?: string;
  wasi?: WasiForkState;
  dl?: DlState;
}

export interface DlState {
  log: LinkRecord[];
  next: number;
  handle: number;
  free: number[];
  live: number[];
}

export interface KernelStreamEntry {
  fd: number;
  kernel: number;
  kind: KernelFdKind;
  flags?: number;
  cloexec?: boolean;
  desc?: number;
  fifo?: string;
}

export type ForkStream = KernelStreamEntry | { fd: number; path: string; flags: number };

export interface InheritedFd {
  fd: number;
  kind: KernelFdKind;
  device?: DeviceMeta;
  flags?: number;
  cloexec?: boolean;
  desc?: number;
  fifo?: string;
}

export interface HeldCwdInit {
  sab: SharedArrayBuffer;
  slot: number;
  seen: number;
  dead: boolean;
}

export interface WasmProcessInitMsg {
  type: typeof WASM_PROCESS_INIT;
  pid: number;
  program: WasmProgram;
  argv0: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  sab: SharedArrayBuffer;
  changes?: SharedArrayBuffer;
  held?: HeldCwdInit;
  ppid?: number;
  umask?: number;
  cred?: Cred;
  owners?: boolean;
  links?: boolean;
  fork?: ForkState;
  fds?: InheritedFd[];
}

export interface JsLane {
  sab: SharedArrayBuffer;
  port: MessagePort;
}

export type JsProcessInitMsg = Omit<WasmProcessInitMsg, 'program' | 'fork'> & {
  program: JsProgram;
  lane?: JsLane;
};

export type ProcessInitMsg = WasmProcessInitMsg | JsProcessInitMsg;

export interface JsThreadSpawnMsg {
  type: typeof JS_THREAD_SPAWN;
  data: unknown;
  port: MessagePort;
  control: MessagePort;
  transfer: Transferable[];
}

export interface JsThreadStart {
  tid: number;
  port: MessagePort;
  data: unknown;
  owned?: SharedArrayBuffer;
}

export type JsThreadInitMsg = Omit<JsProcessInitMsg, 'type'> & {
  type: typeof JS_THREAD_INIT;
  thread: JsThreadStart;
};

export interface JsThreadExitMsg {
  type: typeof JS_THREAD_EXIT;
  code: number;
}

export type JsThreadControl =
  | { tid: number }
  | { errno: 'EAGAIN' | 'ESRCH'; message: string }
  | { exited: number };

export interface WasmProcessExitMsg {
  type: typeof WASM_PROCESS_EXIT;
  code: number;
}

export interface WasmProcessErrorMsg {
  type: typeof WASM_PROCESS_ERROR;
  message: string;
  code?: number;
}

export interface WasmThread {
  tid: number;
  arg: number;
  memory: WebAssembly.Memory;
  ids: SharedArrayBuffer;
  modules?: Record<string, WebAssembly.Module>;
  blocked?: BlockedMask;
}

export interface WasmThreadSpawnMsg {
  type: typeof WASM_THREAD_SPAWN;
  thread: WasmThread;
}

export interface WasmThreadInitMsg extends Omit<WasmProcessInitMsg, 'type' | 'fork' | 'fds'> {
  type: typeof WASM_THREAD_INIT;
  thread: WasmThread;
  signals?: SharedArrayBuffer;
}

export interface WasmThreadExitMsg {
  type: typeof WASM_THREAD_EXIT;
}
