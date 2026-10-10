import type { Termios } from '../../kernel/tty.ts';
import type { WasiFds, WasiKernel } from './wasi-fds.ts';
import { WasiError } from './wasi-files.ts';
import type { WasiMemory } from './wasi-memory.ts';

const NCCS = 32;
const C_LINE = 16;
const C_CC = 17;
const ISPEED = 52;
const OSPEED = 56;
const B38400 = 0o17;
const TCSAFLUSH = 2;

export function writeTermios(mem: WasiMemory, ptr: number, termios: Termios): void {
  mem.bytes(ptr, OSPEED + 4).fill(0);
  const v = mem.view();
  v.setUint32(ptr, termios.c_iflag, true);
  v.setUint32(ptr + 4, termios.c_oflag, true);
  v.setUint32(ptr + 8, termios.c_cflag, true);
  v.setUint32(ptr + 12, termios.c_lflag, true);
  for (let i = 0; i < NCCS; i++) v.setUint8(ptr + C_CC + i, termios.c_cc[i] ?? 0);
  v.setUint8(ptr + C_LINE, 0);
  v.setUint32(ptr + ISPEED, B38400, true);
  v.setUint32(ptr + OSPEED, B38400, true);
}

export function readTermios(mem: WasiMemory, ptr: number): Termios {
  const v = mem.view();
  return {
    c_iflag: v.getUint32(ptr, true),
    c_oflag: v.getUint32(ptr + 4, true),
    c_cflag: v.getUint32(ptr + 8, true),
    c_lflag: v.getUint32(ptr + 12, true),
    c_cc: Array.from({ length: NCCS }, (_, i) => v.getUint8(ptr + C_CC + i)),
  };
}

export function sliccTty(mem: WasiMemory, fds: WasiFds, kernel: WasiKernel) {
  const { sys } = kernel;
  const terminal = (fd: number): number => {
    const e = fds.find(fd);
    if (!e) throw new WasiError('EBADF');
    if (e.type !== 'kernel' || fds.kind(fd, e) !== 'tty') throw new WasiError('ENOTTY');
    return fd;
  };
  const needs = <T>(value: T | undefined): T => {
    if (value === undefined) throw new WasiError('ENOTTY');
    return value;
  };
  const setAttr = (fd: number, actions: number, ptr: number): void => {
    if (actions < 0 || actions > TCSAFLUSH) throw new WasiError('EINVAL');
    const at = terminal(fd);
    needs(sys.tcsets);
    sys.tcsets?.(at, readTermios(mem, ptr));
  };
  const size = (fd: number, ptr: number): void => {
    const [rows, cols] = needs(sys.winsize?.(terminal(fd)));
    mem.bytes(ptr, 8).fill(0);
    const v = mem.view();
    v.setUint16(ptr, rows, true);
    v.setUint16(ptr + 2, cols, true);
  };
  return {
    tcgetattr: (fd: number, ptr: number) =>
      void writeTermios(mem, ptr, needs(sys.tcgets?.(terminal(fd)))),
    tcsetattr: (fd: number, actions: number, ptr: number) => void setAttr(fd, actions, ptr),
    winsize: (fd: number, ptr: number) => void size(fd, ptr),
  };
}
