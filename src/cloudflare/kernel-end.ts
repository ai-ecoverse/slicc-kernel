import { RpcTarget } from 'cloudflare:workers';
import type { ProcessLink } from '../async/link.ts';
import { WASM_PROCESS_ERROR } from '../kernel/protocol.ts';
import { behindProcess } from './clock-skew.ts';
import {
  type Answer,
  Closers,
  dispose,
  Held,
  Inbox,
  type ProcessEndStub,
  send,
} from './rpc-link.ts';

const CLOSED_BY_KERNEL = 'the kernel closed the process';

class KernelState {
  readonly inbox = new Inbox();
  readonly held = new Held();
  readonly closers = new Closers();
  readonly early: { message: unknown; resolve(value: unknown): void; reject(err: Error): void }[] =
    [];
  handler: ((message: unknown) => Promise<unknown>) | undefined;

  get closed(): boolean {
    return this.closers.reason !== undefined;
  }

  call(message: unknown): Promise<unknown> {
    const handler = this.handler;
    return this.closers.guard(
      handler
        ? Promise.resolve().then(() => handler(message))
        : new Promise((resolve, reject) => this.early.push({ message, resolve, reject }))
    );
  }

  listen(handler: (message: unknown) => Promise<unknown>): void {
    this.handler = handler;
    for (const { message, resolve, reject } of this.early.splice(0)) {
      Promise.resolve()
        .then(() => handler(message))
        .then(resolve, reject);
    }
  }

  close(reason: string): boolean {
    if (!this.closers.close(reason)) return false;
    this.early.length = 0;
    this.inbox.clear();
    this.held.clear();
    return true;
  }
}

export class KernelEnd extends RpcTarget {
  readonly #state: KernelState;

  constructor(state: KernelState) {
    super();
    this.#state = state;
  }

  part(bytes: Uint8Array): void {
    this.#state.inbox.part(bytes);
  }

  post(value: unknown, count: number): void {
    const inbox = this.#state.inbox;
    inbox.deliver(inbox.take(value, count));
  }

  async call(value: unknown, count: number, sent?: number): Promise<Answer> {
    const state = this.#state;
    const result = await state.call(behindProcess(state.inbox.take(value, count), sent));
    return state.held.answer(result);
  }

  take(held: number, index: number): Uint8Array {
    return this.#state.held.take(held, index);
  }
}

export interface ProcessHostStub {
  open(kernel: KernelEnd): Promise<ProcessEndStub>;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function openLink(host: ProcessHostStub, released: () => void): Promise<ProcessLink> {
  const state = new KernelState();
  let gone = false;
  const release = (): void => {
    if (gone) return;
    gone = true;
    released();
  };
  let end: ProcessEndStub;
  try {
    end = await host.open(new KernelEnd(state));
  } catch (err) {
    release();
    throw err;
  }
  const lost = (reason: string, failed: boolean): void => {
    release();
    if (state.closed) return;
    if (failed) state.inbox.deliver({ type: WASM_PROCESS_ERROR, message: reason });
    state.close(reason);
    dispose(end);
  };
  end.settled().then(
    (reason) => lost(typeof reason === 'string' ? reason : 'the process closed its link', false),
    (err: unknown) => lost(`the process isolate failed: ${describe(err)}`, true)
  );
  return {
    onClose: (handler) => state.closers.listen(handler),
    post(message) {
      if (!state.closed) send(end, message);
    },
    onPost: (handler) => state.inbox.listen(handler),
    onCall: (handler) => state.listen(handler),
    close() {
      if (!state.close(CLOSED_BY_KERNEL)) return;
      end
        .close(CLOSED_BY_KERNEL)
        .catch(() => {})
        .finally(() => {
          dispose(end);
          release();
        });
    },
  };
}
