export interface PortPair {
  port1: MessagePort;
  port2: MessagePort;
}

export type MakePortPair = () => PortPair;

export const messageChannel: MakePortPair = () => new MessageChannel();

type Listener = EventListenerOrEventListenerObject;

class LocalPort extends EventTarget {
  peer: LocalPort | undefined;
  private started = false;
  private closed = false;
  private readonly inbox: unknown[] = [];
  private flushing = false;
  private handler: ((event: MessageEvent) => void) | null = null;

  get onmessage(): ((event: MessageEvent) => void) | null {
    return this.handler;
  }

  set onmessage(next: ((event: MessageEvent) => void) | null) {
    if (this.handler) super.removeEventListener('message', this.handler as Listener);
    this.handler = next;
    if (next) {
      super.addEventListener('message', next as Listener);
      this.start();
    }
  }

  override addEventListener(
    type: string,
    listener: Listener | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    super.addEventListener(type, listener, options);
    if (type === 'message') this.start();
  }

  postMessage(message: unknown): void {
    if (this.closed) return;
    this.peer?.receive(message);
  }

  receive(message: unknown): void {
    if (this.closed) return;
    this.inbox.push(message);
    this.schedule();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule();
  }

  private schedule(): void {
    if (!this.started || this.flushing || this.inbox.length === 0) return;
    this.flushing = true;
    queueMicrotask(() => {
      this.flushing = false;
      while (this.inbox.length > 0 && !this.closed) {
        this.dispatchEvent(new MessageEvent('message', { data: this.inbox.shift() }));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.inbox.length = 0;
    const peer = this.peer;
    this.peer = undefined;
    queueMicrotask(() => this.dispatchEvent(new Event('close')));
    peer?.close();
  }
}

export const localPorts: MakePortPair = () => {
  const port1 = new LocalPort();
  const port2 = new LocalPort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1: port1 as unknown as MessagePort, port2: port2 as unknown as MessagePort };
};
