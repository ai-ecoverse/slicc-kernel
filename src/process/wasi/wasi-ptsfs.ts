import type { WasmSyscall } from '../../kernel/process.ts';
import {
  type SyncFsBridgeStat,
  type SyncFsPosixBridge,
  syncError,
} from '../../realm/sync-fs-wire.ts';
import { devReaddir, devReadlink, devStat, devSync } from '../js/js-dev.ts';

const PTS = '/dev/pts';
const PTS_ENTRY = /^\/dev\/pts\/(\d+)$/;
const SERIAL_AREA = /^\/dev\/(?:tty(?:USB|ACM)\d+|serial(?:\/.*)?)$/;

export function ptsBridge<T extends SyncFsPosixBridge>(
  fs: T,
  call: (req: WasmSyscall) => unknown
): T {
  const open = (): number[] => call({ op: 'pty-list' }) as number[];
  const kernel = { json: (req: Parameters<typeof call>[0]) => call(req) };
  const entry = (p: string, given?: number[]): SyncFsBridgeStat => {
    const known = given === undefined ? open() : given;
    const n = PTS_ENTRY.exec(p)?.[1];
    if (n === undefined || !known.includes(Number(n))) throw syncError('ENOENT', p);
    return devSync(kernel, devStat(p, true));
  };
  const listedEntry = (name: string, known: number[]): [string, SyncFsBridgeStat | null] => {
    try {
      return [name, entry(`${PTS}/${name}`, known)];
    } catch {
      return [name, null];
    }
  };
  const dir = (): SyncFsBridgeStat => devSync(kernel, devStat(PTS, true));
  const statOf = (p: string, real: () => SyncFsBridgeStat, follow = true): SyncFsBridgeStat => {
    if (p === PTS) return dir();
    if (SERIAL_AREA.test(p)) return devSync(kernel, devStat(p, follow));
    return PTS_ENTRY.test(p) ? entry(p) : real();
  };
  const serialNames = (): string[] =>
    devSync(kernel, devReaddir('/dev')).filter((n) => SERIAL_AREA.test(`/dev/${n}`));
  const withSerial = (listed: string[]): string[] => [
    ...listed,
    ...serialNames().filter((n) => !listed.includes(n)),
  ];
  const names = (given?: number[]): string[] =>
    (given === undefined ? open() : given).map(String).sort();
  const serialEntry = (p: string, name: string): [string, SyncFsBridgeStat | null] => {
    try {
      return [name, devSync(kernel, devStat(p, false))];
    } catch {
      return [name, null];
    }
  };
  const over: Partial<SyncFsPosixBridge> = {
    stat: (p: string) => statOf(p, () => fs.stat(p)),
    lstat: (p: string) => statOf(p, () => fs.lstat(p), false),
    readlink: (p: string) =>
      SERIAL_AREA.test(p) ? devSync(kernel, devReadlink(p)) : fs.readlink(p),
    exists: (p: string) => {
      if (p === PTS) return true;
      if (SERIAL_AREA.test(p)) {
        try {
          devSync(kernel, devStat(p, true));
          return true;
        } catch {
          return false;
        }
      }
      if (!PTS_ENTRY.test(p)) return fs.exists(p);
      return open().includes(Number(PTS_ENTRY.exec(p)?.[1]));
    },
    readdir: (p: string) => {
      if (p === PTS) return names();
      if (SERIAL_AREA.test(p)) return devSync(kernel, devReaddir(p));
      const listed = fs.readdir(p);
      if (p !== '/dev') return listed;
      return withSerial(listed.includes('pts') ? listed : [...listed, 'pts']);
    },
    readdirStat: (p: string) => {
      if (p === PTS) {
        const known = open();
        const listed: Array<[string, SyncFsBridgeStat | null]> = [];
        for (const name of names(known)) listed.push(listedEntry(name, known));
        return listed;
      }
      if (SERIAL_AREA.test(p)) {
        const serial: Array<[string, SyncFsBridgeStat | null]> = [];
        for (const name of devSync(kernel, devReaddir(p))) {
          serial.push(serialEntry(`${p}/${name}`, name));
        }
        return serial;
      }
      const listed = fs.readdirStat(p);
      if (p !== '/dev') return listed;
      const all: Array<[string, SyncFsBridgeStat | null]> = listed.some(([name]) => name === 'pts')
        ? [...listed]
        : [...listed, ['pts', dir()]];
      const have = all.map(([name]) => name);
      for (const name of serialNames()) {
        if (!have.includes(name)) all.push(serialEntry(`/dev/${name}`, name));
      }
      return all;
    },
  };
  return new Proxy(fs, {
    get(target, key, receiver) {
      if (Object.hasOwn(over, key)) return over[key as keyof SyncFsPosixBridge];
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
