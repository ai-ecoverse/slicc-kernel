import { RpcTarget } from 'cloudflare:workers';
import type { KernelLink } from '../async/link.ts';
import { answered, dispose, Inbox, type KernelEndStub, quietly, send } from './rpc-link.ts';
import { pack } from './rpc-pack.ts';

const CLOSED = 'the kernel closed this process';

class ProcessState {
  readonly inbox = new Inbox();
  readonly closers: ((reason: string) => void)[] = [];
  closed = false;
  done: () => void = () => {};
  readonly settled = new Promise<void>((resolve) => {
    this.done = resolve;
  });

  readonly kernel: KernelEndStub;

  constructor(kernel: KernelEndStub) {
    this.kernel = kernel;
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.inbox.clear();
    this.done();
    dispose(this.kernel);
    if (reason === undefined) return;
    for (const handler of this.closers.splice(0)) handler(reason);
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

  close(): void {
    this.#state.close('the kernel closed this process');
  }

  settled(): Promise<void> {
    return this.#state.settled;
  }
}

export interface ClosableKernelLink extends KernelLink {
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

export function processSide(kernel: KernelEndStub): { end: ProcessEnd; link: ClosableKernelLink } {
  const state = new ProcessState(kernel);
  const link: ClosableKernelLink = {
    onClose: (handler) => {
      state.closers.push(handler);
    },
    close: () => state.close(),
    post(message) {
      if (!state.closed) send(kernel, message);
    },
    async call(message) {
      if (state.closed) throw new Error(CLOSED);
      const { value, pieces } = pack(message);
      for (const piece of pieces) quietly(kernel.part(piece));
      return answered(kernel, await kernel.call(value, pieces.length));
    },
    onMessage: (handler) => state.inbox.listen(handler),
  };
  return { end: new ProcessEnd(state), link };
}
