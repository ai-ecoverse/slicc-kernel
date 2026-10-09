const SETUP_OPS = new Set([
  'proc-list',
  'proc-identity',
  'fd-info',
  'sig-mask',
  'proc-setpgid',
  'tty-pgrp-set',
]);

export const SETTLE_MS = 250;

interface Held {
  pgid: number;
  send: () => void;
}

export class SettlingChildren {
  private readonly children = new Map<
    number,
    { ppid: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private held: Held[] = [];
  private readonly pgidOf: (pid: number) => number | undefined;
  private readonly settleMs: number;

  constructor(pgidOf: (pid: number) => number | undefined, settleMs = SETTLE_MS) {
    this.pgidOf = pgidOf;
    this.settleMs = settleMs;
  }

  started(pid: number, ppid: number): void {
    this.children.set(pid, { ppid });
  }

  syscall(pid: number, op: string): void {
    const child = this.children.get(pid);
    if (!child) return;
    if (!SETUP_OPS.has(op)) {
      this.settled(pid);
      return;
    }
    child.timer ??= setTimeout(() => this.settled(pid), this.settleMs);
  }

  settled(pid: number): void {
    const child = this.children.get(pid);
    if (!child) return;
    clearTimeout(child.timer);
    this.children.delete(pid);
    const ready = this.held.filter((h) => !this.blocking(h.pgid));
    this.held = this.held.filter((h) => this.blocking(h.pgid));
    for (const h of ready) h.send();
  }

  deliver(pgid: number, send: () => void): void {
    if (this.blocking(pgid)) this.held.push({ pgid, send });
    else send();
  }

  private blocking(pgid: number): boolean {
    for (const { ppid } of this.children.values()) if (this.pgidOf(ppid) === pgid) return true;
    return false;
  }
}
