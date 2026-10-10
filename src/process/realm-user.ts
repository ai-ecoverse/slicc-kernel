import type { Cred } from '../kernel/cred.ts';
import type { ProcessFs } from './kernel-streams.ts';

export interface Owner {
  uid: number;
  gid: number;
}

export const LEGACY_OWNER: Readonly<Owner> = Object.freeze({ uid: 1000, gid: 1000 });

const CRED_ABI = /\bslicc_cred_js\b/;

export function credAbi(glue: string): boolean {
  return CRED_ABI.test(glue);
}

export function ownByCaller(Fs: ProcessFs, cred?: Readonly<Cred>, abi = true): Owner {
  const owner = abi ? { uid: cred?.euid ?? 0, gid: cred?.egid ?? 0 } : { ...LEGACY_OWNER };
  const { stat, fstat } = Fs;
  const owned = (attr: object): object => ({ ...attr, uid: owner.uid, gid: owner.gid });
  if (typeof stat === 'function') {
    Fs.stat = (path, dontFollow) => owned(stat.call(Fs, path, dontFollow));
  }
  if (typeof fstat === 'function') Fs.fstat = (fd) => owned(fstat.call(Fs, fd));
  return owner;
}
