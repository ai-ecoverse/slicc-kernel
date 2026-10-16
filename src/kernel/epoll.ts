import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import { EventFd, Notifier } from './eventfd.ts';
import {
  type FdTable,
  KernelError,
  type KernelFile,
  kernelFdKind,
  OpenFile,
  type PollState,
  pollFile,
} from './fd-table.ts';
import { timerAfter, timerAt } from './timer.ts';

export const EPOLL = {
  IN: 1,
  OUT: 2,
  RDHUP: 4,
  PRI: 8,
  ERR: 16,
  HUP: 32,
  ET: 64,
  ONESHOT: 128,
} as const;

const ALWAYS = EPOLL.ERR | EPOLL.HUP;
const ASKED = EPOLL.IN | EPOLL.OUT | EPOLL.RDHUP;
const RETRY_MS = 50;
const UNPOLLABLE: ReadonlySet<string> = new Set(['file', 'held', 'device']);

export type EpollOp = 'add' | 'mod' | 'del' | 'set';

export interface EpollEvent {
  events: number;
  data: number[];
}

export type EpollSyscall =
  | { op: 'epoll-create' }
  | { op: 'epoll-ctl'; epfd: number; how: EpollOp; fd: number; events: number; data: number[] }
  | { op: 'epoll-wait'; epfd: number; max: number; timeoutMs: number }
  | { op: 'eventfd-open'; initial: string; semaphore: boolean };

export const EPOLL_OPS: readonly EpollSyscall['op'][] = [
  'epoll-create',
  'epoll-ctl',
  'epoll-wait',
  'eventfd-open',
];

export interface Interest {
  events: number;
  gen: number;
  reported: number;
  armed: boolean;
}

export function levelOf(file: KernelFile): number {
  const state: PollState = pollFile(file);
  let bits = 0;
  if (state.readable) bits |= EPOLL.IN;
  if (state.writable) bits |= EPOLL.OUT;
  if (state.rdhup) bits |= EPOLL.RDHUP;
  if (state.error) bits |= EPOLL.ERR;
  if (state.hangup) bits |= file.read ? EPOLL.HUP : EPOLL.ERR;
  return bits;
}

export function due(interest: Interest, level: number): number {
  if (!interest.armed) return 0;
  const ready = level & ((interest.events & ASKED) | ALWAYS);
  if (ready === 0) return 0;
  if ((interest.events & EPOLL.ET) !== 0 && interest.reported === interest.gen) return 0;
  return ready;
}

export function consume(interest: Interest): void {
  interest.reported = interest.gen;
  if ((interest.events & EPOLL.ONESHOT) !== 0) interest.armed = false;
}

interface Registration extends Interest {
  fd: number;
  open: OpenFile;
  data: number[];
  stop: AbortController;
  unhook: () => void;
}

function lookup(fds: FdTable, fd: number): OpenFile | undefined {
  try {
    return fds.get(fd);
  } catch {
    return undefined;
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const cancel = timerAfter(ms, resolve);
    signal.addEventListener(
      'abort',
      () => {
        cancel();
        resolve();
      },
      { once: true }
    );
  });
}

export class EpollFile implements KernelFile {
  private readonly regs = new Map<number, Registration>();
  private readonly changes = new Notifier();
  private cursor = 0;

  ctl(fds: FdTable, how: EpollOp, fd: number, events: number, data: number[]): void {
    const open = fds.get(fd);
    if (open.file === this) throw new KernelError('EINVAL');
    const known = this.regs.get(fd);
    const current = known?.open === open ? known : undefined;
    if (how === 'add' || (how === 'set' && !current)) {
      if (current) throw new KernelError('EEXIST');
      if (UNPOLLABLE.has(kernelFdKind(open.file))) throw new KernelError('EPERM');
      if (open.file instanceof EpollFile && open.file.reaches(this)) throw new KernelError('ELOOP');
      if (known) this.drop(known);
      this.register(fd, open, events, data);
    } else if (!current) {
      throw new KernelError('ENOENT');
    } else if (how === 'del') {
      this.drop(current);
    } else {
      current.events = events;
      current.data = data;
      current.armed = true;
      current.gen++;
    }
    this.changes.wake();
  }

  reaches(target: EpollFile): boolean {
    if (this === target) return true;
    return [...this.regs.values()].some(
      (reg) => reg.open.file instanceof EpollFile && reg.open.file.reaches(target)
    );
  }

  collect(fds: FdTable, max: number): EpollEvent[] {
    const list = [...this.regs.values()];
    const out: EpollEvent[] = [];
    const start = list.length === 0 ? 0 : this.cursor % list.length;
    for (let i = 0; i < list.length && out.length < max; i++) {
      const reg = list[(start + i) % list.length];
      if (lookup(fds, reg.fd) !== reg.open) {
        this.drop(reg);
        continue;
      }
      const bits = due(reg, levelOf(reg.open.file));
      if (bits === 0) continue;
      consume(reg);
      out.push({ events: bits, data: reg.data });
      this.cursor = start + i + 1;
    }
    return out;
  }

  async wait(
    fds: FdTable,
    max: number,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<EpollEvent[]> {
    const deadline = timeoutMs < 0 ? Number.POSITIVE_INFINITY : performance.now() + timeoutMs;
    for (;;) {
      const events = this.collect(fds, max);
      if (events.length > 0 || performance.now() >= deadline) return events;
      const round = new AbortController();
      const woken = this.changes.wait(AbortSignal.any([round.signal, signal]));
      woken.catch(() => undefined);
      let cancel = (): void => {};
      const expiry =
        deadline === Number.POSITIVE_INFINITY
          ? []
          : [new Promise<void>((resolve) => (cancel = timerAt(deadline, resolve)))];
      try {
        await Promise.race([woken, ...expiry]);
      } finally {
        round.abort();
        cancel();
      }
    }
  }

  poll(): PollState {
    const ready = [...this.regs.values()].some((reg) => due(reg, levelOf(reg.open.file)) !== 0);
    return { readable: ready, writable: false, hangup: false };
  }

  changed(signal?: AbortSignal): Promise<void> {
    return this.changes.wait(signal);
  }

  close(): void {
    for (const reg of [...this.regs.values()]) this.drop(reg);
    this.changes.wake();
  }

  private register(fd: number, open: OpenFile, events: number, data: number[]): void {
    const stop = new AbortController();
    const unhook = open.onClose(() => {
      this.drop(reg);
      this.changes.wake();
    });
    const reg: Registration = {
      fd,
      open,
      events,
      data,
      gen: 1,
      reported: 0,
      armed: true,
      stop,
      unhook,
    };
    this.regs.set(fd, reg);
    void this.watch(reg);
  }

  private drop(reg: Registration): void {
    reg.stop.abort();
    reg.unhook();
    if (this.regs.get(reg.fd) === reg) this.regs.delete(reg.fd);
  }

  private async watch(reg: Registration): Promise<void> {
    const file = reg.open.file;
    const { signal } = reg.stop;
    while (file.changed && !signal.aborted) {
      const round = new AbortController();
      const stop = (): void => round.abort();
      signal.addEventListener('abort', stop, { once: true });
      let failed = false;
      try {
        await file.changed(round.signal);
      } catch {
        failed = true;
      } finally {
        round.abort();
        signal.removeEventListener('abort', stop);
      }
      if (signal.aborted) return;
      reg.gen++;
      this.changes.wake();
      if (failed) await pause(RETRY_MS, signal);
    }
  }
}

export interface EpollProcess {
  fds: FdTable;
  blocking(): AbortSignal;
  owed(): boolean;
}

function epollAt(fds: FdTable, fd: number): EpollFile {
  const file = fds.get(fd).file;
  if (!(file instanceof EpollFile)) throw new KernelError('EINVAL');
  return file;
}

const ok = (json?: unknown): SyncFsResult =>
  json === undefined ? { ok: true, kind: 'void' } : { ok: true, kind: 'json', json };

export async function epollSyscall(req: EpollSyscall, proc: EpollProcess): Promise<SyncFsResult> {
  const { fds } = proc;
  switch (req.op) {
    case 'epoll-create':
      return ok(fds.install(new OpenFile(new EpollFile()), 3));
    case 'eventfd-open':
      return ok(fds.install(new OpenFile(new EventFd(BigInt(req.initial), req.semaphore)), 3));
    case 'epoll-ctl':
      epollAt(fds, req.epfd).ctl(fds, req.how, req.fd, req.events, req.data);
      return ok();
    case 'epoll-wait': {
      const ep = epollAt(fds, req.epfd);
      if (req.timeoutMs === 0 || proc.owed()) {
        const now = ep.collect(fds, req.max);
        if (req.timeoutMs === 0 || now.length > 0) return ok(now);
      }
      return ok(await ep.wait(fds, req.max, req.timeoutMs, proc.blocking()));
    }
  }
}
