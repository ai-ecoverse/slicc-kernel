import type { Termios } from './tty.ts';

export const IOCTL = {
  TCGETS: 0x5401,
  TCSETS: 0x5402,
  TCSETSW: 0x5403,
  TCSETSF: 0x5404,
  TCSBRK: 0x5409,
  TCFLSH: 0x540b,
  TIOCEXCL: 0x540c,
  TIOCNXCL: 0x540d,
  TIOCSCTTY: 0x540e,
  TIOCGPGRP: 0x540f,
  TIOCSPGRP: 0x5410,
  TIOCOUTQ: 0x5411,
  TIOCGWINSZ: 0x5413,
  TIOCSWINSZ: 0x5414,
  TIOCMGET: 0x5415,
  TIOCMBIS: 0x5416,
  TIOCMBIC: 0x5417,
  TIOCMSET: 0x5418,
  FIONREAD: 0x541b,
  TIOCNOTTY: 0x5422,
  TCSBRKP: 0x5425,
  TIOCSBRK: 0x5427,
  TIOCCBRK: 0x5428,
  TCGETS2: 0x802c542a,
  TCSETS2: 0x402c542b,
  TCSETSW2: 0x402c542c,
  TCSETSF2: 0x402c542d,
} as const;

export const FILE_IOCTLS: ReadonlySet<number> = new Set([0x5421, 0x5450, 0x5451, 0x5452]);

export const TERMIOS_GETS: ReadonlySet<number> = new Set([IOCTL.TCGETS, IOCTL.TCGETS2]);

export const TERMIOS_SETS: ReadonlySet<number> = new Set([
  IOCTL.TCSETS,
  IOCTL.TCSETSW,
  IOCTL.TCSETSF,
  IOCTL.TCSETS2,
  IOCTL.TCSETSW2,
  IOCTL.TCSETSF2,
]);

export const INT_OUT: ReadonlySet<number> = new Set([
  IOCTL.TIOCMGET,
  IOCTL.FIONREAD,
  IOCTL.TIOCOUTQ,
]);

export const INT_IN: ReadonlySet<number> = new Set([
  IOCTL.TIOCMBIS,
  IOCTL.TIOCMBIC,
  IOCTL.TIOCMSET,
]);

export const INT_ARG: ReadonlySet<number> = new Set([IOCTL.TCSBRK, IOCTL.TCSBRKP, IOCTL.TCFLSH]);

export const TIOCM = {
  DTR: 0x002,
  RTS: 0x004,
  CTS: 0x020,
  CD: 0x040,
  RI: 0x080,
  DSR: 0x100,
} as const;

export interface SerialTermios extends Termios {
  c_ispeed?: number;
  c_ospeed?: number;
}

export interface SerialSettings {
  baudRate: number;
  dataBits: number;
  parity: 'none' | 'even' | 'odd';
  stopBits: 1 | 2;
  flowControl: 'none' | 'hardware';
}

export const CBAUD = 0o10017;
export const BOTHER = 0o10000;
const IBSHIFT = 16;
const CSIZE = 0o60;
const CSTOPB = 0o100;
const PARENB = 0o400;
const PARODD = 0o1000;
const CRTSCTS = 0x80000000;

const SPEEDS: readonly number[] = [
  0, 50, 75, 110, 134, 150, 200, 300, 600, 1200, 1800, 2400, 4800, 9600, 19200, 38400,
];
const FAST: readonly number[] = [
  0, 57600, 115200, 230400, 460800, 500000, 576000, 921600, 1000000, 1152000, 1500000, 2000000,
  2500000, 3000000, 3500000, 4000000,
];

export function speedOf(code: number): number | undefined {
  if (code === BOTHER) return undefined;
  return code & BOTHER ? FAST[code & 0o17] : SPEEDS[code & 0o17];
}

export function codeOf(speed: number): number {
  const low = SPEEDS.indexOf(speed);
  if (low >= 0) return low;
  const high = FAST.indexOf(speed);
  return high > 0 ? BOTHER | high : BOTHER;
}

export function speedsOf(
  termios: SerialTermios,
  current: { ispeed: number; ospeed: number },
  extended: boolean
): { ispeed: number; ospeed: number } {
  const out = termios.c_cflag & CBAUD;
  const ospeed =
    speedOf(out) ?? (extended ? (termios.c_ospeed ?? current.ospeed) >>> 0 : current.ospeed);
  const inCode = (termios.c_cflag >>> IBSHIFT) & CBAUD;
  if (inCode === 0) return { ispeed: ospeed, ospeed };
  const ispeed =
    speedOf(inCode) ?? (extended ? (termios.c_ispeed ?? current.ispeed) >>> 0 : current.ispeed);
  return { ispeed, ospeed };
}

export function settingsOf(cflag: number, baudRate: number): SerialSettings {
  return {
    baudRate,
    dataBits: 5 + ((cflag & CSIZE) >> 4),
    parity: cflag & PARENB ? (cflag & PARODD ? 'odd' : 'even') : 'none',
    stopBits: cflag & CSTOPB ? 2 : 1,
    flowControl: cflag & CRTSCTS ? 'hardware' : 'none',
  };
}

export function sameSettings(a: SerialSettings, b: SerialSettings): boolean {
  return (
    a.baudRate === b.baudRate &&
    a.dataBits === b.dataBits &&
    a.parity === b.parity &&
    a.stopBits === b.stopBits &&
    a.flowControl === b.flowControl
  );
}

export const SERIAL_CFLAG = 0o15 | 0o60 | 0o200 | 0o2000 | 0o4000;
export const SERIAL_LFLAG = 0o20 | 0o40 | 0o1000 | 0o4000;
export const SERIAL_OFLAG = 0o4;

const NCCS = 32;
const NCCS2 = 19;
const C_LINE = 16;
const C_CC = 17;

function readFlags(view: DataView, at: number, ncc: number): SerialTermios {
  const cCc = new Array<number>(NCCS).fill(0);
  for (let i = 0; i < ncc; i++) cCc[i] = view.getUint8(at + C_CC + i);
  return {
    c_iflag: view.getUint32(at, true),
    c_oflag: view.getUint32(at + 4, true),
    c_cflag: view.getUint32(at + 8, true),
    c_lflag: view.getUint32(at + 12, true),
    c_cc: cCc,
  };
}

function writeFlags(view: DataView, at: number, t: SerialTermios, ncc: number): void {
  view.setUint32(at, t.c_iflag >>> 0, true);
  view.setUint32(at + 4, t.c_oflag >>> 0, true);
  view.setUint32(at + 8, t.c_cflag >>> 0, true);
  view.setUint32(at + 12, t.c_lflag >>> 0, true);
  view.setUint8(at + C_LINE, 0);
  for (let i = 0; i < ncc; i++) view.setUint8(at + C_CC + i, t.c_cc[i] ?? 0);
}

export function ioctlArg(view: DataView, request: number, arg: number): unknown {
  if (TERMIOS_SETS.has(request)) {
    if (request > 0xffff) {
      const t = readFlags(view, arg, NCCS2);
      return {
        ...t,
        c_ispeed: view.getUint32(arg + 36, true),
        c_ospeed: view.getUint32(arg + 40, true),
      };
    }
    return readFlags(view, arg, NCCS);
  }
  if (INT_IN.has(request)) return view.getInt32(arg, true);
  if (INT_ARG.has(request)) return arg | 0;
  if (request === IOCTL.TIOCSWINSZ)
    return { rows: view.getUint16(arg, true), cols: view.getUint16(arg + 2, true) };
  return undefined;
}

export function ioctlResult(view: DataView, request: number, arg: number, result: unknown): void {
  if (TERMIOS_GETS.has(request)) {
    const t = result as SerialTermios;
    if (request === IOCTL.TCGETS2) {
      writeFlags(view, arg, t, NCCS2);
      view.setUint32(arg + 36, (t.c_ispeed ?? 0) >>> 0, true);
      view.setUint32(arg + 40, (t.c_ospeed ?? 0) >>> 0, true);
    } else {
      writeFlags(view, arg, t, NCCS);
      view.setUint32(arg + 52, t.c_cflag & CBAUD, true);
      view.setUint32(arg + 56, t.c_cflag & CBAUD, true);
    }
  } else if (INT_OUT.has(request)) view.setInt32(arg, Number(result) | 0, true);
  else if (request === IOCTL.TIOCGWINSZ) {
    const size = result as { rows: number; cols: number };
    view.setUint16(arg, size.rows, true);
    view.setUint16(arg + 2, size.cols, true);
    view.setUint32(arg + 4, 0, true);
  }
}
