import type { ChildStdio, InheritedSlot } from '../../kernel/children.ts';
import type { Cred } from '../../kernel/cred.ts';
import { defaultAction } from '../../kernel/signals.ts';
import { inheritedSignals } from '../process-children.ts';
import { identify } from '../process-runtime.ts';
import type { EmContext } from './context.ts';
import { EM, errnoOf, negated } from './errno.ts';
import { afterStopped, holdStopped, sleepIn } from './wasi.ts';

const WNOHANG = 1;
const WUNTRACED = 2;
const WCONTINUED = 8;

const IDS = ['ruid', 'euid', 'suid', 'rgid', 'egid', 'sgid'] as const;

export interface ProcState {
  seeded: { bits: number };
  raise(sig: number): void;
}

function strings(ctx: EmContext, ptr: number): string[] {
  const out: string[] = [];
  if (!ptr) return out;
  const v = ctx.mem.view();
  for (let i = 0; ; i++) {
    const s = v.getUint32(ptr + i * 4, true);
    if (!s) break;
    out.push(ctx.mem.cString(s));
  }
  return out;
}

function envOf(ctx: EmContext, ptr: number): Record<string, string> | null {
  if (!ptr) return null;
  const env: Record<string, string> = {};
  for (const kv of strings(ctx, ptr)) {
    const eq = kv.indexOf('=');
    if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return env;
}

function restartedCall(ctx: EmContext, req: Parameters<EmContext['call']>[0]): unknown {
  for (;;) {
    try {
      return ctx.call(req);
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'EINTR') throw e;
    }
  }
}

function slot(ctx: EmContext, fd: number): ChildStdio {
  const e = fd >= 0 ? ctx.host.fds.find(fd) : undefined;
  if (!e) return { none: true };
  if (e.type === 'kernel') return { fd };
  if (e.type === 'dir') return { dir: e.path };
  if (e.type === 'device') return { device: e.device, ...(e.access ? { access: e.access } : {}) };
  return { none: true };
}

function inherited(ctx: EmContext, actions: Array<[number, number]>): InheritedSlot[] {
  const { fds } = ctx.host;
  const table = new Map<number, { slot: InheritedSlot | undefined; cloexec: boolean }>();
  for (const entry of fds.snapshot()) {
    const cloexec = fds.cloexec.has(entry.fd);
    if (entry.type === 'kernel')
      table.set(entry.fd, { slot: { fd: entry.fd, kernel: entry.fd }, cloexec });
    else if (entry.type === 'device') {
      const access = entry.access ? { access: entry.access } : {};
      table.set(entry.fd, { slot: { fd: entry.fd, device: entry.device, ...access }, cloexec });
    } else table.set(entry.fd, { slot: undefined, cloexec });
  }
  for (const [target, source] of actions) {
    if (target <= 2) continue;
    const from = source >= 0 ? table.get(source) : undefined;
    if (from?.slot) {
      const moved =
        'kernel' in from.slot
          ? { fd: target, kernel: from.slot.kernel }
          : { ...from.slot, fd: target };
      table.set(target, { slot: moved, cloexec: false });
    } else table.delete(target);
  }
  const out: InheritedSlot[] = [];
  for (const [fd, { slot: s, cloexec }] of table) {
    if (fd > 2 && !cloexec && s) out.push(s);
  }
  return out;
}

export function kernelWait(
  ctx: EmContext,
  pid: number,
  nohang: boolean,
  options = 0
): [number, number] | number {
  const req = {
    op: 'proc-wait' as const,
    pid,
    nohang,
    ...(options & WUNTRACED ? { untraced: true } : {}),
    ...(options & WCONTINUED ? { continued: true } : {}),
  };
  for (;;) {
    try {
      const waited = (ctx.call(req) as [number, number] | undefined) ?? [0, 0];
      if (waited[0] > 0) ctx.host.o.fs.invalidate?.();
      return [waited[0], waited[1]];
    } catch (e) {
      const errno = errnoOf(e);
      if (errno === undefined) throw e;
      if (errno === 27 && ctx.gate.restartable()) continue;
      return -errno;
    }
  }
}

function execWait(ctx: EmContext, pid: number): number {
  try {
    const r = ctx.call({ op: 'proc-exec', pid }) as [number, number] | undefined;
    ctx.host.o.fs.invalidate?.();
    return r ? r[1] : 0;
  } catch (e) {
    const errno = errnoOf(e);
    if (errno === undefined) throw e;
    return -errno;
  }
}

function spawnChild(
  ctx: EmContext,
  req: {
    file: string;
    argv: string[];
    env: Record<string, string> | null;
    cwd: string | null;
    stdio: number[];
    actions: Array<[number, number]>;
    exec: boolean;
  }
): number {
  const { fds } = ctx.host;
  try {
    fds.flushAll();
    fds.promoteFiles();
  } catch (e) {
    const errno = errnoOf(e);
    if (errno === undefined) throw e;
    return -errno;
  }
  const stdio: ChildStdio[] = [];
  for (let n = 0; n < 3; n++) stdio.push(slot(ctx, req.stdio[n] ?? -1));
  const inherit = inherited(ctx, req.actions);
  const spawn = {
    op: 'proc-spawn' as const,
    file: req.file,
    argv: req.argv,
    env: req.env ?? ctx.init.env,
    cwd: req.cwd ?? ctx.cwd.path,
    ...(req.cwd !== null ? { chdir: true as const } : {}),
    stdio,
    ...(inherit.length > 0 ? { inherit } : {}),
    ...(req.exec ? { exec: true } : {}),
    restart: true as const,
  };
  try {
    return restartedCall(ctx, spawn) as number;
  } catch (e) {
    const errno = errnoOf(e);
    if (errno === undefined) throw e;
    return -errno;
  } finally {
    ctx.host.o.fs.invalidate?.();
  }
}

function throughKernel(sig: number): boolean {
  if (sig === 0) return false;
  const action = defaultAction(sig);
  return action === 'terminate' || action === 'stop';
}

function status(ctx: EmContext, req: Parameters<EmContext['call']>[0]): number {
  try {
    ctx.call(req);
    return 0;
  } catch (e) {
    const errno = errnoOf(e);
    if (errno === undefined) throw e;
    return -errno;
  }
}

function numberOf(ctx: EmContext, req: Parameters<EmContext['call']>[0]): number {
  try {
    const r = ctx.call(req);
    return typeof r === 'number' ? r : -EM.IO;
  } catch (e) {
    const errno = errnoOf(e);
    if (errno === undefined) throw e;
    return -errno;
  }
}

function terminal(ctx: EmContext, fd: number): boolean {
  return ctx.host.fds.find(fd)?.type === 'kernel';
}

function jobs(ctx: EmContext, op: number, a: number, b: number): number {
  switch (op) {
    case 0:
      return status(ctx, { op: 'proc-setpgid', pid: a, pgid: b });
    case 1:
      return numberOf(ctx, { op: 'proc-getpgid', pid: a });
    case 2:
      return numberOf(ctx, { op: 'proc-getsid', pid: a });
    case 3:
      return numberOf(ctx, { op: 'proc-setsid' });
    case 4:
      return terminal(ctx, a) ? numberOf(ctx, { op: 'tty-pgrp-get', fd: a }) : -EM.NOTTY;
    case 5:
      return terminal(ctx, a) ? status(ctx, { op: 'tty-pgrp-set', fd: a, pgrp: b }) : -EM.NOTTY;
  }
  return -EM.NOSYS;
}

function credOf(ctx: EmContext): Cred {
  return ctx.call({ op: 'proc-cred' }) as Cred;
}

export function procImports(ctx: EmContext, state: ProcState): WebAssembly.ModuleImports {
  const { mem } = ctx;
  const cred = ctx.host.sliccImports();
  return {
    slicc_spawn_capture_js: (
      path: number,
      argv: number,
      envp: number,
      cwd: number,
      inFd: number,
      outFd: number,
      errFd: number,
      actions: number,
      nactions: number
    ) => {
      const file = mem.cString(path);
      if (!file) return -EM.NOENT;
      const pairs: Array<[number, number]> = [];
      const v = mem.view();
      for (let i = 0; i < nactions; i++) {
        pairs.push([v.getInt32(actions + 8 * i, true), v.getInt32(actions + 8 * i + 4, true)]);
      }
      return spawnChild(ctx, {
        file,
        argv: strings(ctx, argv),
        env: envOf(ctx, envp),
        cwd: cwd ? mem.cString(cwd) : null,
        stdio: [inFd === -2 ? 0 : inFd, outFd, errFd],
        actions: pairs,
        exec: false,
      });
    },
    slicc_wait_js: (pid: number, statusPtr: number, options: number) => {
      const r = kernelWait(ctx, pid, (options & WNOHANG) !== 0, options);
      if (typeof r === 'number') return r;
      if (statusPtr && r[0] > 0) mem.view().setInt32(statusPtr, r[1], true);
      return r[0];
    },
    slicc_exec_detach: () => 0,
    slicc_exec_wait_js: (pid: number) => execWait(ctx, pid),
    slicc_execve_js: (path: number, argv: number, envp: number) => {
      const file = mem.cString(path);
      if (!file) return -EM.NOENT;
      const pid = spawnChild(ctx, {
        file,
        argv: strings(ctx, argv),
        env: envOf(ctx, envp),
        cwd: null,
        stdio: [0, 1, 2],
        actions: [],
        exec: true,
      });
      if (pid < 0) return pid;
      return execWait(ctx, pid);
    },
    slicc_in_emulated_fork: () => 0,
    slicc_getpid_js: () => ctx.pid,
    slicc_getppid_js: () => identify(ctx.transport, ctx.init).ppid,
    slicc_default_getpid_js: () => ctx.pid | 0 || 42,
    slicc_default_getppid_js: () => ctx.ppid | 0 || 1,
    slicc_kill_js: (pid: number, sig: number) => {
      if (pid === ctx.init.pid && !throughKernel(sig)) {
        if (sig !== 0) state.raise(sig);
        return 0;
      }
      return status(ctx, { op: 'proc-kill', pid, sig });
    },
    slicc_pause_js: () => status(ctx, { op: 'sig-pause' }),
    slicc_sig_inherited_js: () => {
      try {
        const bits = inheritedSignals(ctx.transport);
        state.seeded.bits |= bits;
        return bits | 0;
      } catch {
        return 0;
      }
    },
    slicc_jobs_js: (op: number, a: number, b: number) => jobs(ctx, op, a, b),
    slicc_cred_js: negated((out: number) => {
      const c = credOf(ctx);
      const v = mem.view();
      for (let i = 0; i < IDS.length; i++) v.setUint32(out + i * 4, c[IDS[i]] >>> 0, true);
    }),
    slicc_groups_js: negated((list: number, cap: number) => {
      const { groups } = credOf(ctx);
      if (cap === 0) return groups.length;
      if (cap < groups.length) return -EM.INVAL;
      const v = mem.view();
      for (let i = 0; i < groups.length; i++)
        v.setUint32(list + i * 4, (groups[i] as number) >>> 0, true);
      return groups.length;
    }),
    slicc_setcred_js: (...ids: number[]) => {
      const set = cred.cred_set as (...ids: number[]) => number;
      const r = set(...ids);
      return r === 0 ? 0 : -r;
    },
    slicc_setgroups_js: (list: number, n: number) => {
      const set = cred.groups_set as (buf: number, n: number) => number;
      const r = set(list, n);
      return r === 0 ? 0 : -r;
    },
    slicc_sleep_ms: (ms: number) => {
      holdStopped(ctx);
      sleepIn(ctx, ms);
      afterStopped(ctx);
    },
  };
}
