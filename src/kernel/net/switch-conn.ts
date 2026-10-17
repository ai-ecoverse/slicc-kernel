import type { UplinkConn } from './uplink.ts';

type Pulled = Uint8Array | null | Error;

export class SwitchConn implements UplinkConn {
  private readonly raw: UplinkConn;
  private readonly box: Pulled[] = [];
  private pulling = false;
  private waiters: Array<() => void> = [];
  private switching = false;
  private secure: UplinkConn | undefined;
  private failed: Error | undefined;
  constructor(raw: UplinkConn) {
    this.raw = raw;
  }
  get localAddr(): string {
    return this.raw.localAddr;
  }
  get remoteAddr(): string {
    return this.raw.remoteAddr;
  }
  get upgraded(): boolean {
    return this.switching || this.secure !== undefined;
  }
  private wake(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }
  private changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  private pull(): void {
    if (this.pulling || this.box.length > 0) return;
    this.pulling = true;
    this.raw
      .read()
      .then(
        (bytes) => this.box.push(bytes),
        (err: unknown) => this.box.push(err instanceof Error ? err : new Error(String(err)))
      )
      .finally(() => {
        this.pulling = false;
        this.wake();
      });
  }
  private take(): Uint8Array | null {
    const next = this.box.shift() as Pulled;
    if (next instanceof Error) throw next;
    return next;
  }
  private async rawRead(): Promise<Uint8Array | null> {
    while (this.box.length === 0) {
      this.pull();
      await this.changed();
    }
    return this.take();
  }
  async read(): Promise<Uint8Array | null> {
    for (;;) {
      if (this.failed) throw this.failed;
      if (this.secure) return this.secure.read();
      if (!this.switching && this.box.length > 0) return this.take();
      if (!this.switching) this.pull();
      await this.changed();
    }
  }
  private async settled(): Promise<UplinkConn> {
    while (this.switching) await this.changed();
    if (this.failed) throw this.failed;
    return this.secure ?? this.raw;
  }
  async write(bytes: Uint8Array): Promise<number> {
    return (await this.settled()).write(bytes);
  }
  closeWrite(): void {
    void this.settled().then(
      (conn) => conn.closeWrite(),
      () => undefined
    );
  }
  close(): void {
    this.failed ??= new Error('closed');
    this.secure?.close();
    this.raw.close();
    this.wake();
  }
  async upgrade<T>(make: (raw: UplinkConn) => Promise<{ conn: UplinkConn; info: T }>): Promise<T> {
    if (this.upgraded) throw new Error('already upgraded');
    this.switching = true;
    this.wake();
    const view: UplinkConn = {
      localAddr: this.raw.localAddr,
      remoteAddr: this.raw.remoteAddr,
      read: () => this.rawRead(),
      write: (bytes) => this.raw.write(bytes),
      closeWrite: () => this.raw.closeWrite(),
      close: () => this.raw.close(),
    };
    try {
      const { conn, info } = await make(view);
      this.secure = conn;
      return info;
    } catch (err) {
      this.failed = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      this.switching = false;
      this.wake();
    }
  }
}
