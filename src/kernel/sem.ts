import { permits, R_OK, W_OK } from '../fs/access.ts';
import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import type { Cred } from './cred.ts';
import { type ForkedHandles, KernelError } from './fd-table.ts';
import { timerAt } from './timer.ts';

export const SEM_VALUE_MAX = 0x7fff_ffff;
export const SEM_NAMES_MAX = 4096;
export const SEM_HANDLES_MAX = 256;
const NAME_MAX = 251;

export type SemWaitHow = 'block' | 'try' | 'timed';

export type SemSyscall =
  | {
      op: 'sem-open';
      name: string;
      create: boolean;
      exclusive: boolean;
      mode: number;
      value: number;
    }
  | { op: 'sem-close'; handle: number }
  | { op: 'sem-unlink'; name: string }
  | { op: 'sem-post'; handle: number }
  | { op: 'sem-wait'; handle: number; how: SemWaitHow; timeoutMs: number }
  | { op: 'sem-getvalue'; handle: number };

export const SEM_OPS: readonly SemSyscall['op'][] = [
  'sem-open',
  'sem-close',
  'sem-unlink',
  'sem-post',
  'sem-wait',
  'sem-getvalue',
];

interface Waiter {
  grant(): void;
}

export class Semaphore {
  value: number;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  private readonly waiters: Waiter[] = [];

  constructor(value: number, uid: number, gid: number, mode: number) {
    this.value = value;
    this.uid = uid;
    this.gid = gid;
    this.mode = mode;
  }

  post(): void {
    const next = this.waiters.shift();
    if (next) next.grant();
    else if (this.value >= SEM_VALUE_MAX) throw new KernelError('EOVERFLOW');
    else this.value++;
  }

  take(): boolean {
    if (this.value === 0) return false;
    this.value--;
    return true;
  }

  wait(signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    if (this.take()) return Promise.resolve(true);
    if (signal.aborted) return Promise.reject(new KernelError('EINTR'));
    return new Promise((resolve, reject) => {
      const deadline = timeoutMs < 0 ? Number.POSITIVE_INFINITY : performance.now() + timeoutMs;
      let cancel = (): void => {};
      const leave = (): void => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        cancel();
        signal.removeEventListener('abort', abort);
      };
      const waiter: Waiter = {
        grant: () => {
          leave();
          resolve(true);
        },
      };
      const abort = (): void => {
        leave();
        reject(new KernelError('EINTR'));
      };
      const expire = (): void => {
        leave();
        resolve(false);
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', abort, { once: true });
      if (deadline !== Number.POSITIVE_INFINITY) {
        cancel = timerAt(deadline, expire);
      }
    });
  }
}

interface Entry {
  sem: Semaphore;
  opens: number;
}

export class SemTable {
  private readonly names = new Map<string, Semaphore>();
  private readonly limit: number;

  constructor(limit = SEM_NAMES_MAX) {
    this.limit = limit;
  }

  open(
    name: string,
    create: boolean,
    exclusive: boolean,
    make: () => Semaphore,
    check: (s: Semaphore) => void,
    adopt: (s: Semaphore) => number
  ): number {
    const found = this.names.get(name);
    if (found) {
      if (create && exclusive) throw new KernelError('EEXIST');
      check(found);
      return adopt(found);
    }
    if (!create) throw new KernelError('ENOENT');
    if (this.names.size >= this.limit) throw new KernelError('ENOSPC');
    const sem = make();
    const handle = adopt(sem);
    this.names.set(name, sem);
    return handle;
  }

  unlink(name: string, check: (s: Semaphore) => void): void {
    const found = this.names.get(name);
    if (!found) throw new KernelError('ENOENT');
    check(found);
    this.names.delete(name);
  }
}

export class SemHandles implements ForkedHandles {
  private readonly byHandle = new Map<number, Entry>();
  private next = 1;

  add(sem: Semaphore): number {
    for (const [handle, entry] of this.byHandle) {
      if (entry.sem === sem) {
        entry.opens++;
        return handle;
      }
    }
    if (this.byHandle.size >= SEM_HANDLES_MAX) throw new KernelError('EMFILE');
    const handle = this.next++;
    this.byHandle.set(handle, { sem, opens: 1 });
    return handle;
  }

  get(handle: number): Semaphore {
    const entry = this.byHandle.get(handle);
    if (!entry) throw new KernelError('EINVAL');
    return entry.sem;
  }

  close(handle: number): void {
    const entry = this.byHandle.get(handle);
    if (!entry) throw new KernelError('EINVAL');
    if (--entry.opens === 0) this.byHandle.delete(handle);
  }

  fork(): SemHandles {
    const child = new SemHandles();
    child.next = this.next;
    for (const [handle, entry] of this.byHandle) child.byHandle.set(handle, { ...entry });
    return child;
  }

  clear(): void {
    this.byHandle.clear();
  }
}

export function semName(raw: string): string {
  const name = raw.replace(/^\/+/, '');
  if (name === '' || name.includes('/') || name === '.' || name === '..') {
    throw new KernelError('EINVAL');
  }
  if (new TextEncoder().encode(name).length > NAME_MAX) throw new KernelError('ENAMETOOLONG');
  return name;
}

export interface SemProcess {
  table: SemTable | undefined;
  handles: SemHandles;
  cred: Readonly<Cred>;
  denied: ((op: string, path: string) => void) | undefined;
  umask: number;
  blocking(): AbortSignal;
}

const ok = (json?: unknown): SyncFsResult =>
  json === undefined ? { ok: true, kind: 'void' } : { ok: true, kind: 'json', json };

export async function semSyscall(req: SemSyscall, proc: SemProcess): Promise<SyncFsResult> {
  const { table, handles, cred } = proc;
  if (!table) throw new KernelError('ENOSYS');
  const { denied } = proc;
  const shown = (name: string) => `/dev/shm/sem.${name}`;
  const opens = (name: string) => (sem: Semaphore) => {
    const perm = { uid: sem.uid, gid: sem.gid, mode: sem.mode };
    if (denied && !permits(cred, perm, R_OK | W_OK, false)) denied('sem_open', shown(name));
  };
  const unlinks = (name: string) => (sem: Semaphore) => {
    if (denied && cred.euid !== 0 && cred.euid !== sem.uid) denied('sem_unlink', shown(name));
  };
  switch (req.op) {
    case 'sem-open': {
      if (req.value < 0 || req.value > SEM_VALUE_MAX) throw new KernelError('EINVAL');
      const name = semName(req.name);
      const mode = req.mode & 0o777 & ~proc.umask;
      return ok(
        table.open(
          name,
          req.create,
          req.exclusive,
          () => new Semaphore(req.value, cred.euid, cred.egid, mode),
          opens(name),
          (sem) => handles.add(sem)
        )
      );
    }
    case 'sem-close':
      handles.close(req.handle);
      return ok();
    case 'sem-unlink': {
      const name = semName(req.name);
      table.unlink(name, unlinks(name));
      return ok();
    }
    case 'sem-post':
      handles.get(req.handle).post();
      return ok();
    case 'sem-getvalue':
      return ok(handles.get(req.handle).value);
    case 'sem-wait': {
      const sem = handles.get(req.handle);
      if (sem.take()) return ok();
      if (req.how === 'try') throw new KernelError('EAGAIN');
      if (req.how === 'timed' && req.timeoutMs === 0) throw new KernelError('ETIMEDOUT');
      const got = await sem.wait(proc.blocking(), req.how === 'block' ? -1 : req.timeoutMs);
      if (!got) throw new KernelError('ETIMEDOUT');
      return ok();
    }
  }
}
