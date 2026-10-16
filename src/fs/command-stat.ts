import { access, R_OK } from './access.ts';
import type { Guard } from './dac.ts';
import type { FsStat } from './types.ts';

export async function callerStat(g: Guard | undefined, path: string, st: FsStat): Promise<FsStat> {
  if (!g?.fs.commandTarget || !st.isFile || st.size > 0) return st;
  const target = await g.fs.commandTarget(path);
  if (target === undefined) return st;
  const options = { directory: false, ...(g.links === undefined ? {} : { links: g.links }) };
  const walked = await access(g.fs, g.cred, target, R_OK, options).catch(() => undefined);
  if (!walked || walked.denied !== undefined || walked.missing) return st;
  const real = await g.fs.stat(target).catch(() => undefined);
  if (!real?.isFile) return st;
  const { size, mtime } = real;
  return { ...st, size, mtime, atime: mtime, ctime: mtime };
}
