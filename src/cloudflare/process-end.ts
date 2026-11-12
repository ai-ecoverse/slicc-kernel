import { RpcTarget } from 'cloudflare:workers';
import type { KernelLink } from '../async/link.ts';
import {
  answered,
  Closers,
  dispose,
  Inbox,
  type KernelEndStub,
  quietly,
  send,
} from './rpc-link.ts';
import { pack } from './rpc-pack.ts';

const CLOSED_BY_PROCESS = 'the process closed its link';

class ProcessState {
  readonly inbox = new Inbox();
  readonly closers = new Closers();
  done: (reason: string) => void = () => {};
  readonly settled = new Promise<string>((resolve) => {
    this.done = resolve;
  });

  readonly kernel: KernelEndStub;

  constructor(kernel: KernelEndStub) {
    this.kernel = kernel;
  }

  get closed(): boolean {
    return this.closers.reason !== undefined;
  }

  close(reason: string): void {
    if (!this.closers.close(reason)) return;
    this.inbox.clear();
    this.done(reason);
    dispose(this.kernel);
  }
}

export class ProcessEnd extends RpcTarget {
  readonly #state: ProcessState;

  constructor(state: ProcessState) {
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

  close(reason: string): void {
    this.#state.close(typeof reason === 'string' ? reason : 'the kernel closed the process');
  }

  settled(): Promise<string> {
    return this.#state.settled;
  }
}

export function processSide(kernel: KernelEndStub): { end: ProcessEnd; link: KernelLink } {
  const state = new ProcessState(kernel);
  const link: KernelLink = {
    onClose: (handler) => state.closers.listen(handler),
    close: () => state.close(CLOSED_BY_PROCESS),
    post(message) {
      if (!state.closed) send(kernel, message);
    },
    call(message) {
      if (state.closed) return state.closers.guard(Promise.resolve());
      const { value, pieces } = pack(message);
      for (const piece of pieces) quietly(kernel.part(piece));
      return state.closers.guard(
        kernel.call(value, pieces.length, Date.now()).then((answer) => answered(kernel, answer))
      );
    },
    onMessage: (handler) => state.inbox.listen(handler),
  };
  return { end: new ProcessEnd(state), link };
}
