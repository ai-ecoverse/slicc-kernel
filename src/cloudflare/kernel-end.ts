import { RpcTarget } from 'cloudflare:workers';
import type { ProcessLink } from '../async/link.ts';
import { WASM_PROCESS_ERROR } from '../kernel/protocol.ts';
import { type Answer, dispose, Held, Inbox, type ProcessEndStub, send } from './rpc-link.ts';

const CLOSED = 'the process link is closed';

class KernelState {
  readonly inbox = new Inbox();
  readonly held = new Held();
  readonly early: { message: unknown; resolve(value: unknown): void; reject(err: Error): void }[] =
    [];
  readonly calls = new Set<(err: Error) => void>();
  handler: ((message: unknown) => Promise<unknown>) | undefined;
  closed = false;

  async call(message: unknown): Promise<unknown> {
    if (this.closed) throw new Error(CLOSED);
    const handler = this.handler;
    const asked = handler
      ? handler(message)
      : new Promise((resolve, reject) => this.early.push({ message, resolve, reject }));
    let reject: (err: Error) => void = () => {};
    const ended = new Promise<never>((_, fail) => {
      reject = fail;
    });
    this.calls.add(reject);
    try {
      return await Promise.race([asked, ended]);
    } finally {
      this.calls.delete(reject);
    }
  }

  listen(handler: (message: unknown) => Promise<unknown>): void {
    this.handler = handler;
    for (const { message, resolve, reject } of this.early.splice(0)) {
      handler(message).then(resolve, reject);
    }
  }

  close(): void {
    this.closed = true;
    const err = new Error(CLOSED);
    for (const reject of [...this.calls]) reject(err);
    for (const { reject } of this.early.splice(0)) reject(err);
    this.inbox.clear();
    this.held.clear();
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

  async call(value: unknown, count: number): Promise<Answer> {
    const state = this.#state;
    const result = await state.call(state.inbox.take(value, count));
    return state.held.answer(result);
  }

  take(held: number, index: number): Uint8Array {
    return this.#state.held.take(held, index);
  }
}

export interface ClosableProcessLink extends ProcessLink {
  onClose(handler: (reason: string) => void): void;
}

export interface ProcessHostStub {
  open(kernel: KernelEnd): Promise<ProcessEndStub>;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function openLink(
  host: ProcessHostStub,
  released: () => void
): Promise<ClosableProcessLink> {
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
  const closers: ((reason: string) => void)[] = [];
  const lost = (reason: string, failed: boolean): void => {
    release();
    if (state.closed) return;
    if (failed) state.inbox.deliver({ type: WASM_PROCESS_ERROR, message: reason });
    for (const handler of closers.splice(0)) handler(reason);
  };
  end.settled().then(
    () => lost('the process closed its link', false),
    (err: unknown) => lost(`the process isolate failed: ${describe(err)}`, true)
  );
  return {
    onClose: (handler) => {
      closers.push(handler);
    },
    post(message) {
      if (!state.closed) send(end, message);
    },
    onPost: (handler) => state.inbox.listen(handler),
    onCall: (handler) => state.listen(handler),
    close() {
      if (state.closed) return;
      state.close();
      end
        .close()
        .catch(() => {})
        .finally(() => {
          dispose(end);
          release();
        });
    },
  };
}
