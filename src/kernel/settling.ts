const SETUP_OPS = new Set([
  'proc-list',
  'proc-identity',
  'fd-info',
  'sig-mask',
  'proc-setpgid',
  'tty-pgrp-set',
  'proc-exec',
  'proc-spawn',
]);

export const SETTLE_MS = 2000;

const KEY_SIGNALS = new Set([2, 3, 20]);

interface Held {
  pgid: number;
  send: () => void;
  copy?: boolean;
}

export class SettlingChildren {
  private readonly children = new Map<
    number,
    { ppid: number; execer?: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private held: Held[] = [];
  private parked: Held[] = [];
  private readonly pgidOf: (pid: number) => number | undefined;
  private readonly settleMs: number;

  constructor(pgidOf: (pid: number) => number | undefined, settleMs = SETTLE_MS) {
    this.pgidOf = pgidOf;
    this.settleMs = settleMs;
  }

  started(pid: number, ppid: number): void {
    const parent = this.children.get(ppid);
    this.children.set(pid, parent ? { ppid: parent.ppid, execer: ppid } : { ppid });
    const group = this.pgidOf(ppid);
    for (const p of this.parked) if (p.pgid === group) this.held.push({ ...p, copy: true });
    this.parked = this.parked.filter((p) => p.pgid !== group);
  }

  reading(pgid: number): void {
    this.parked = this.parked.filter((p) => p.pgid !== pgid);
    this.held = this.held.filter((h) => !(h.copy && h.pgid === pgid));
  }

  isSettling(pid: number): boolean {
    return this.children.has(pid);
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
    if (child.execer !== undefined) this.settled(child.execer);
    const ready = this.held.filter((h) => !this.blocking(h.pgid));
    this.held = this.held.filter((h) => this.blocking(h.pgid));
    for (const h of ready) h.send();
  }

  deliver(sig: number, pgid: number, send: () => void, foreground?: () => number): void {
    if (!KEY_SIGNALS.has(sig)) {
      send();
    } else if (this.blocking(pgid)) {
      this.held.push({ pgid, send });
    } else if (foreground) {
      send();
      const moved = () => {
        if (foreground() !== pgid) send();
      };
      this.parked.push({ pgid, send: moved });
    } else {
      send();
    }
  }

  private blocking(pgid: number): boolean {
    for (const { ppid } of this.children.values()) if (this.pgidOf(ppid) === pgid) return true;
    return false;
  }
}
