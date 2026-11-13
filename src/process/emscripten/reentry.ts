import { reentered } from '../wasi/wasm-reentry.ts';

export type WasmExport = (...args: never[]) => unknown;

const UNWINDING = 1;

export class Reentry {
  private readonly stack: string[] = [];
  private state: () => number = () => 0;
  private stopUnwind: () => void = () => {};
  unwound: string | undefined;

  bind(exports: WebAssembly.Exports): void {
    const state = exports.asyncify_get_state;
    const stop = exports.asyncify_stop_unwind;
    if (typeof state === 'function') this.state = state as () => number;
    if (typeof stop === 'function') this.stopUnwind = stop as () => void;
  }

  enter(name: string, fn: WasmExport, args: readonly unknown[]): unknown {
    this.stack.push(name);
    try {
      return reentered(fn as (...a: unknown[]) => unknown)(...args);
    } finally {
      this.stack.pop();
      if (this.stack.length === 0 && this.state() === UNWINDING) {
        this.stopUnwind();
        this.unwound = name;
      }
    }
  }
}
