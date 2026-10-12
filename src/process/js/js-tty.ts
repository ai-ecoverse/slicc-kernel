import type { FdInfo } from './js-io.ts';
import type { JsKernel } from './js-kernel.ts';

export interface JsTermios {
  c_iflag: number;
  c_oflag: number;
  c_cflag: number;
  c_lflag: number;
  c_cc: number[];
}

export interface JsTtySize {
  columns: number;
  rows: number;
}

export interface JsTty {
  getAttr(fd: number): Promise<JsTermios>;
  setAttr(fd: number, termios: JsTermios): Promise<void>;
  setRaw(fd: number, raw: boolean): Promise<void>;
  size(fd: number): Promise<JsTtySize>;
  foreground(fd: number): Promise<number>;
  setForeground(fd: number, pgrp: number): Promise<void>;
}

const BRKINT = 0o2;
const INPCK = 0o20;
const ISTRIP = 0o40;
const ICRNL = 0o400;
const IXON = 0o2000;
const ONLCR = 0o4;
const CS8 = 0o60;
const ISIG = 0o1;
const ICANON = 0o2;
const ECHO = 0o10;
const IEXTEN = 0o100000;
const VTIME = 5;
const VMIN = 6;

function copy(termios: JsTermios): JsTermios {
  return { ...termios, c_cc: [...termios.c_cc] };
}

export function rawOf(termios: JsTermios): JsTermios {
  const raw = copy(termios);
  raw.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
  raw.c_oflag |= ONLCR;
  raw.c_cflag |= CS8;
  raw.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
  raw.c_cc[VMIN] = 1;
  raw.c_cc[VTIME] = 0;
  return raw;
}

export function ttyOps(kernel: JsKernel): {
  tty: JsTty;
  restore(): Promise<void>;
  modes(): Array<{ fd: number; termios: JsTermios }>;
} {
  const saved = new Map<string, { fd: number; termios: JsTermios }>();
  const terminalOf = async (fd: number): Promise<string> =>
    ((await kernel.json({ op: 'fd-info', fd })) as FdInfo).terminal ?? `fd ${fd}`;

  const getAttr = async (fd: number): Promise<JsTermios> =>
    (await kernel.json({ op: 'tty-get', fd })) as JsTermios;
  const setAttr = async (fd: number, termios: JsTermios): Promise<void> => {
    await kernel.call({ op: 'tty-set', fd, termios: copy(termios) });
  };

  const tty: JsTty = {
    getAttr,
    setAttr,
    async setRaw(fd, raw) {
      const terminal = await terminalOf(fd);
      if (!raw) {
        const original = saved.get(terminal);
        saved.delete(terminal);
        if (original) await setAttr(fd, original.termios);
        return;
      }
      const current = await getAttr(fd);
      if (!saved.has(terminal)) saved.set(terminal, { fd, termios: current });
      await setAttr(fd, rawOf(current));
    },
    async size(fd) {
      const [rows, columns] = (await kernel.json({ op: 'tty-winsz', fd })) as [number, number];
      return { columns, rows };
    },
    foreground: async (fd) => (await kernel.json({ op: 'tty-pgrp-get', fd })) as number,
    async setForeground(fd, pgrp) {
      await kernel.call({ op: 'tty-pgrp-set', fd, pgrp });
    },
  };

  const openOn = async (terminal: string, fd: number): Promise<number | undefined> => {
    const open = (await kernel.json({ op: 'fd-list' })) as Array<FdInfo & { fd: number }>;
    const on = open.filter((entry) => entry.terminal === terminal);
    return (on.find((entry) => entry.fd === fd) ?? on[0])?.fd;
  };
  const reopened = async (terminal: string, termios: JsTermios): Promise<void> => {
    const fd = (await kernel.json({ op: 'fd-open-tty', name: terminal })) as number;
    try {
      await setAttr(fd, termios);
    } finally {
      await kernel.call({ op: 'fd-close', fd });
    }
  };
  const restore = async (): Promise<void> => {
    for (const [terminal, { fd, termios }] of [...saved].reverse()) {
      saved.delete(terminal);
      const at = await openOn(terminal, fd).catch(() => undefined);
      const back = at === undefined ? reopened(terminal, termios) : setAttr(at, termios);
      await back.catch(() => undefined);
    }
  };

  const modes = () => [...saved.values()].reverse().map(({ fd, termios }) => ({ fd, termios }));
  return { tty, restore, modes };
}
