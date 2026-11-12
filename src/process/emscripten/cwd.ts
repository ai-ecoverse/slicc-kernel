import { physicalPath } from '../../fs/physical-path.ts';
import { type CwdAnswer, HeldCwd, type HeldCwdReply } from '../../kernel/held-cwd.ts';
import type { WasmSyscall } from '../../kernel/process.ts';
import type { HeldCwdInit } from '../../kernel/protocol.ts';
import type { WasiHost } from '../wasi/wasi-host.ts';
import { EM, EmError } from './errno.ts';

export const AT_FDCWD = -100;

const X_OK = 1;

export class EmCwd {
  path: string;
  private held: HeldCwd | undefined;
  private readonly host: WasiHost;
  private readonly call: (req: WasmSyscall) => unknown;

  constructor(
    host: WasiHost,
    path: string,
    call: (req: WasmSyscall) => unknown,
    held: HeldCwdInit | undefined
  ) {
    this.host = host;
    this.path = path;
    this.call = call;
    if (held) {
      const ask = () => call({ op: 'cwd-check' }) as CwdAnswer;
      this.held = new HeldCwd(held.sab, held.slot, ask, { ...held, path });
    }
  }

  gone(): boolean {
    return this.held !== undefined && !this.held.alive(this.path);
  }

  base(dirfd: number): string {
    if (dirfd === AT_FDCWD) return this.path;
    const e = this.host.fds.get(dirfd);
    if (e.type === 'dir') return e.path;
    if (e.type === 'file') return e.file.path;
    throw new EmError(EM.NOTDIR);
  }

  resolve(dirfd: number, raw: string, allowEmpty = false): string {
    if (raw === '') {
      if (!allowEmpty) throw new EmError(EM.NOENT);
      return this.base(dirfd);
    }
    if (raw.startsWith('/')) return this.host.fds.resolve(0, raw);
    const relativeHere = raw.split('/')[0] !== '..';
    if (dirfd === AT_FDCWD && relativeHere && this.gone()) throw new EmError(EM.NOENT);
    const base = this.base(dirfd);
    return this.host.fds.resolve(0, `${base === '/' ? '' : base}/${raw}`);
  }

  chdir(abs: string): void {
    const fs = this.host.o.fs;
    const real = physicalPath(fs, abs);
    const st = fs.stat(real);
    if (!st.isDirectory) throw new EmError(EM.NOTDIR);
    if (fs.owners) fs.access?.(real, X_OK, 'eaccess', false);
    this.path = real;
    if (this.held) {
      const reply = this.call({ op: 'cwd-chdir', path: real }) as HeldCwdReply;
      this.held.moved(reply, real);
    }
  }
}
