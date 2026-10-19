import type { HeldCwd, HeldCwdReply } from '../kernel/held-cwd.ts';

export const DELETED = ' (deleted)';

export const relativeHere = (path: string): boolean =>
  !path.startsWith('/') && path.split('/')[0] !== '..';

export const cwdFor = (cwd: string, held: HeldCwd | undefined, path: string): string =>
  held && relativeHere(path) && !held.alive() ? `${cwd}${DELETED}` : cwd;

export interface HeldCwdFs {
  chdir?(path: string): void;
  cwd?(): string;
  sliccHeldCwd?(): string;
}

export function holdingCwd(
  Fs: HeldCwdFs,
  held: HeldCwd,
  chdirred: (path: string) => HeldCwdReply
): void {
  const { chdir, cwd } = Fs;
  if (!chdir || !cwd) return;
  Fs.sliccHeldCwd = () => cwd.call(Fs);
  Fs.cwd = () => {
    const path = cwd.call(Fs);
    return held.alive() ? path : `${path}${DELETED}`;
  };
  Fs.chdir = (path: string) => {
    chdir.call(Fs, path);
    held.moved(chdirred(cwd.call(Fs)));
  };
}
