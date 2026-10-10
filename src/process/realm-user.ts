import type { Cred } from '../kernel/cred.ts';
import type { ProcessFs } from './kernel-streams.ts';

export interface Owner {
  uid: number;
  gid: number;
}

export function ownByCaller(Fs: ProcessFs, cred?: Readonly<Cred>): Owner {
  const owner = { uid: cred?.euid ?? 0, gid: cred?.egid ?? 0 };
  const { stat, fstat } = Fs;
  const owned = (attr: object): object => ({ ...attr, uid: owner.uid, gid: owner.gid });
  if (typeof stat === 'function') {
    Fs.stat = (path, dontFollow) => owned(stat.call(Fs, path, dontFollow));
  }
  if (typeof fstat === 'function') Fs.fstat = (fd) => owned(fstat.call(Fs, fd));
  return owner;
}
