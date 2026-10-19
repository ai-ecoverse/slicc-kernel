import { type CopyOptions, fsError, type KernelFs } from './types.ts';

async function present(fs: KernelFs, path: string): Promise<boolean> {
  return fs.lstat(path).then(
    () => true,
    (err: { code?: string }) => {
      if (err?.code === 'ENOENT') return false;
      throw err;
    }
  );
}

export async function copyByBytes(
  fs: KernelFs,
  from: string,
  to: string,
  options: CopyOptions
): Promise<void> {
  if (!(await fs.stat(from)).isFile) throw fsError('EINVAL', `${from}: not a regular file`);
  const bytes = await fs.readFileBuffer(from);
  let created = false;
  if (options.exclusive) {
    if (fs.createExclusive) await fs.createExclusive(to, options.owner);
    else if (await present(fs, to)) throw fsError('EEXIST', to);
    created = true;
  } else created = !(await present(fs, to));
  try {
    await fs.writeFile(to, bytes, options.owner);
  } catch (err) {
    if (created) await fs.rm(to, { file: true }).catch(() => undefined);
    throw err;
  }
}
