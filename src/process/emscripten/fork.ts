import type { ForkState } from '../../kernel/protocol.ts';
import type { WasiForkState } from '../wasi/wasix-fork.ts';
import type { EmContext } from './context.ts';

const REWINDING = 2;
const ASYNCIFY_STACK = 1048576;

export class EmFork {
  private forking = false;
  forkSp = 0;
  data = 0;
  private value = 0;
  private readonly ctx: EmContext;

  constructor(ctx: EmContext) {
    this.ctx = ctx;
  }

  supported(): boolean {
    return typeof this.ctx.exports().asyncify_start_unwind === 'function';
  }

  forkImport(): number {
    const ex = this.ctx.exports();
    if (ex.asyncify_get_state?.() === REWINDING) {
      ex.asyncify_stop_rewind?.();
      ex.free?.(this.data);
      this.data = 0;
      return this.value;
    }
    this.forking = true;
    this.forkSp = (ex.emscripten_stack_get_current as () => number)();
    const ptr = (ex.malloc as (n: number) => number)(12 + ASYNCIFY_STACK);
    const v = this.ctx.mem.view();
    v.setUint32(ptr, ptr + 12, true);
    v.setUint32(ptr + 4, ptr + 12 + ASYNCIFY_STACK, true);
    v.setInt32(ptr + 8, 0, true);
    this.data = ptr;
    ex.asyncify_start_unwind?.(ptr);
    return 0;
  }

  settle(ret: unknown): unknown {
    let result = ret;
    for (;;) {
      const name = this.ctx.reentry.unwound;
      if (name === undefined) return result;
      this.ctx.reentry.unwound = undefined;
      if (!this.forking) {
        throw new Error(`${this.ctx.init.argv0}: unexpected Asyncify suspension (not a fork)`);
      }
      this.forking = false;
      result = this.resume(name, this.kernelFork(name));
    }
  }

  resume(name: string, value: number): unknown {
    const ex = this.ctx.exports();
    (ex._emscripten_stack_restore as (sp: number) => void)(this.forkSp);
    this.value = value;
    ex.asyncify_start_rewind?.(this.data);
    return this.ctx.enter(name, ex[name] as (...args: never[]) => unknown, []);
  }

  child(state: ForkState): unknown {
    const memory = this.ctx.exports().memory;
    if (state.memory.length > memory.buffer.byteLength) {
      memory.grow(Math.ceil((state.memory.length - memory.buffer.byteLength) / 65536));
    }
    new Uint8Array(memory.buffer).set(state.memory);
    state.memory = new Uint8Array(0);
    this.data = state.currData;
    this.forkSp = state.forkSp;
    const name = state.callStackNames[0]?.[1] ?? 'main';
    return this.settle(this.resume(name, 0));
  }

  private snapshot(name: string): ForkState {
    const { host, cwd } = this.ctx;
    const memory = this.ctx.mem.bytes(0, this.ctx.mem.size()).slice();
    const wasi: WasiForkState = {
      asyncifyData: this.data,
      globals: [],
      fds: host.fds.snapshot(),
      cloexec: [...host.fds.cloexec],
      cwd: cwd.path,
    };
    return {
      memory,
      currData: this.data,
      forkSp: this.forkSp,
      callStackNames: [[0, name]],
      ppid: this.ctx.pid,
      wasi,
    };
  }

  private kernelFork(name: string): number {
    const { host, gate } = this.ctx;
    try {
      host.fds.flushAll();
      host.fds.promoteFiles();
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (typeof code !== 'string') throw e;
      return -5;
    }
    let seen = gate.deliveries();
    let state = this.snapshot(name);
    for (;;) {
      try {
        return this.ctx.call({ op: 'proc-fork', state, restart: true }) as number;
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        if (code !== 'EINTR') {
          if (typeof code !== 'string') throw e;
          return -11;
        }
        if (gate.deliveries() !== seen) {
          seen = gate.deliveries();
          state = this.snapshot(name);
        }
      }
    }
  }
}
