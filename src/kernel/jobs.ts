import { KernelError } from './fd-table.ts';
import type { KernelTty } from './tty.ts';

export interface JobMember {
  pid: number;
  pgid: number;
  sid: number;

  signal(sig: number): void;

  execParent?: number;

  ppid?: number;

  execed?: boolean;

  shownAs?: number;
}

export class JobTable {
  private readonly members = new Map<number, JobMember>();
  private readonly foreground = new Map<KernelTty, number>();

  private readonly terminals = new Map<number, KernelTty>();

  add(
    pid: number,
    parentPid: number | undefined,
    signal: (sig: number) => void,
    terminal?: KernelTty
  ): JobMember {
    const parent = parentPid === undefined ? undefined : this.members.get(parentPid);
    if (!parent && terminal) this.terminals.set(pid, terminal);
    const member: JobMember = {
      pid,
      ppid: parent?.pid,
      pgid: parent?.pgid ?? pid,
      sid: parent?.sid ?? pid,
      signal,
    };
    this.members.set(pid, member);
    return member;
  }

  list(): JobMember[] {
    return [...this.members.values()];
  }

  remove(pid: number): void {
    this.members.delete(pid);
  }

  exec(pid: number, child: number, adopt = false): void {
    const member = this.members.get(child);
    if (member && adopt) member.shownAs = this.shown(pid);
    if (member) member.execParent = pid;
    const execer = this.members.get(pid);
    if (execer) execer.execed = true;
  }

  shown(pid: number): number {
    let member = this.members.get(pid);
    for (let up = member; up; up = this.members.get(up.execParent ?? -1)) member = up;
    return member?.pid ?? pid;
  }

  shownParent(pid: number): number | undefined {
    const parent = this.members.get(this.shown(pid))?.ppid;
    return parent === undefined ? undefined : this.shown(parent);
  }

  sessionOf(pgid: number): number | undefined {
    for (const member of this.members.values()) if (member.pgid === pgid) return member.sid;
    return undefined;
  }

  join(pid: number, pgid: number): void {
    const sid = this.sessionOf(pgid);
    if (sid === undefined) throw new KernelError('ESRCH');
    const member = this.member(pid);
    member.pgid = pgid;
    member.sid = sid;
  }

  pgidOf(pid: number): number | undefined {
    return this.members.get(pid)?.pgid;
  }

  private member(pid: number): JobMember {
    const member = this.members.get(pid);
    if (!member) throw new KernelError('ESRCH');
    return member;
  }

  private idOf(pid: number): number {
    return this.members.get(pid)?.shownAs ?? pid;
  }

  private byId(id: number): JobMember {
    for (const member of this.members.values()) if (member.shownAs === id) return member;
    return this.member(id);
  }

  setpgid(caller: number, pid: number, pgid: number): void {
    const me = this.idOf(caller);
    const target = this.byId(pid || me);
    const id = this.idOf(target.pid);
    const group = pgid || id;
    if (group < 0) throw new KernelError('EINVAL');
    const self = this.member(caller);
    if (id !== me) {
      if (target.ppid === undefined || this.idOf(target.ppid) !== me) {
        throw new KernelError('ESRCH');
      }
      if (target.execed) throw new KernelError('EACCES');
    }
    if (target.sid !== self.sid) throw new KernelError('EPERM');
    if (id === target.sid) throw new KernelError('EPERM');

    const exists = [...this.members.values()].some((m) => m.pgid === group && m.sid === target.sid);
    if (group !== id && !exists) throw new KernelError('EPERM');
    target.pgid = group;
  }

  getpgid(caller: number, pid: number): number {
    return this.byId(pid || this.idOf(caller)).pgid;
  }

  getsid(caller: number, pid: number): number {
    return this.byId(pid || this.idOf(caller)).sid;
  }

  setsid(pid: number): number {
    const member = this.member(pid);
    const id = this.idOf(pid);
    if (member.pgid === id) throw new KernelError('EPERM');
    member.sid = id;
    member.pgid = id;
    this.terminals.delete(id);
    return id;
  }

  terminalNamed(name: string): KernelTty | undefined {
    const known = new Set([...this.terminals.values(), ...this.foreground.keys()]);
    return [...known].find((tty) => tty.name === name);
  }

  controllingTerminal(pid: number): KernelTty | null | undefined {
    const member = this.members.get(pid);
    return member && (this.terminals.get(member.sid) ?? null);
  }

  acquireTerminal(pid: number, tty: KernelTty): boolean {
    const member = this.members.get(pid);
    const id = this.idOf(pid);
    if (!member || member.sid !== id || this.terminals.has(id)) return false;
    if ([...this.terminals.values()].includes(tty)) return false;
    this.terminals.set(id, tty);
    this.foreground.set(tty, member.pgid);
    return true;
  }

  killGroup(pgid: number, sig: number): boolean {
    const targets = [...this.members.values()].filter((m) => m.pgid === pgid);
    const pids = new Set(targets.map((m) => m.pid));
    if (sig !== 0) {
      for (const m of targets)
        if (m.execParent === undefined || !pids.has(m.execParent)) m.signal(sig);
    }
    return targets.length > 0;
  }

  tcgetpgrp(tty: KernelTty, fallback: number): number {
    return this.foreground.get(tty) ?? fallback;
  }

  tcsetpgrp(caller: number, tty: KernelTty, pgid: number): void {
    const self = this.member(caller);
    const inSession = [...this.members.values()].some((m) => m.pgid === pgid && m.sid === self.sid);
    if (!inSession) throw new KernelError('EPERM');
    this.foreground.set(tty, pgid);
  }

  signalOwnedForeground(tty: KernelTty, sig: number): void {
    const pgid = this.foreground.get(tty);
    if (pgid !== undefined) this.killGroup(pgid, sig);
  }

  signalForeground(tty: KernelTty, fallback: number, sig: number): void {
    this.killGroup(this.tcgetpgrp(tty, fallback), sig);
  }
}
