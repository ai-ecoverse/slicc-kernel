import type { WasmSyscall } from '../../kernel/process.ts';
import {
  type SyncFsBridgeStat,
  type SyncFsPosixBridge,
  syncError,
} from '../../realm/sync-fs-wire.ts';
import { devStat, devSync } from '../js/js-dev.ts';

const PTS = '/dev/pts';
const PTS_ENTRY = /^\/dev\/pts\/(\d+)$/;

export function ptsBridge<T extends SyncFsPosixBridge>(
  fs: T,
  call: (req: WasmSyscall) => unknown
): T {
  const open = (): number[] => call({ op: 'pty-list' }) as number[];
  const kernel = { json: (req: Parameters<typeof call>[0]) => call(req) };
  const entry = (p: string): SyncFsBridgeStat => {
    const n = PTS_ENTRY.exec(p)?.[1];
    if (n === undefined || !open().includes(Number(n))) throw syncError('ENOENT', p);
    return devSync(kernel, devStat(p, true));
  };
  const dir = (): SyncFsBridgeStat => devSync(kernel, devStat(PTS, true));
  const statOf = (p: string, real: () => SyncFsBridgeStat): SyncFsBridgeStat => {
    if (p === PTS) return dir();
    return PTS_ENTRY.test(p) ? entry(p) : real();
  };
  const names = (): string[] => open().map(String).sort();
  const over: Partial<Record<keyof SyncFsPosixBridge, unknown>> = {
    stat: (p: string) => statOf(p, () => fs.stat(p)),
    lstat: (p: string) => statOf(p, () => fs.lstat(p)),
    exists: (p: string) => {
      if (p === PTS) return true;
      if (!PTS_ENTRY.test(p)) return fs.exists(p);
      return open().includes(Number(PTS_ENTRY.exec(p)?.[1]));
    },
    readdir: (p: string) => {
      if (p === PTS) return names();
      const listed = fs.readdir(p);
      return p === '/dev' && !listed.includes('pts') ? [...listed, 'pts'] : listed;
    },
    readdirStat: (p: string) => {
      if (p === PTS) return names().map((name) => [name, entry(`${PTS}/${name}`)]);
      const listed = fs.readdirStat(p);
      if (p !== '/dev' || listed.some(([name]) => name === 'pts')) return listed;
      return [...listed, ['pts', dir()]];
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
