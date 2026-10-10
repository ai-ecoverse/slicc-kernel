const MAX_HOPS = 40;

interface Walk {
  done: string[];
  todo: string[];
  hops: number;
}

function start(path: string): Walk {
  return { done: [], todo: path.split('/').filter((p) => p !== ''), hops: 0 };
}

function next(walk: Walk): string | undefined {
  while (walk.todo.length > 0) {
    const part = walk.todo.shift() as string;
    if (part === '.') continue;
    if (part === '..') {
      walk.done.pop();
      continue;
    }
    return part;
  }
  return undefined;
}

function lexical(path: string): string {
  const walk = start(path);
  for (let part = next(walk); part !== undefined; part = next(walk)) walk.done.push(part);
  return `/${walk.done.join('/')}`;
}

function rest(walk: Walk, part: string): string {
  return lexical(`/${[...walk.done, part, ...walk.todo].join('/')}`);
}

function follow(walk: Walk, target: string): boolean {
  if (++walk.hops > MAX_HOPS) return false;
  if (target.startsWith('/')) walk.done.length = 0;
  walk.todo = [...target.split('/').filter((p) => p !== ''), ...walk.todo];
  return true;
}

export interface LinkReader {
  lstat(path: string): { isSymbolicLink?: boolean };
  readlink(path: string): string;
}

export function physicalPath(fs: LinkReader, path: string): string {
  const walk = start(path);
  for (let part = next(walk); part !== undefined; part = next(walk)) {
    const at = `/${[...walk.done, part].join('/')}`;
    let target: string | undefined;
    try {
      target = fs.lstat(at).isSymbolicLink ? fs.readlink(at) : undefined;
    } catch {
      return rest(walk, part);
    }
    if (target === undefined) walk.done.push(part);
    else if (!follow(walk, target)) {
      throw Object.assign(new Error('too many levels of symbolic links'), { code: 'ELOOP' });
    }
  }
  return `/${walk.done.join('/')}`;
}

export interface AsyncLinkReader {
  lstat(path: string): Promise<{ isSymbolicLink?: boolean }>;
  readlink(path: string): Promise<string>;
}

export async function physicalPathAsync(fs: AsyncLinkReader, path: string): Promise<string> {
  const walk = start(path);
  for (let part = next(walk); part !== undefined; part = next(walk)) {
    const at = `/${[...walk.done, part].join('/')}`;
    let target: string | undefined;
    try {
      target = (await fs.lstat(at)).isSymbolicLink ? await fs.readlink(at) : undefined;
    } catch {
      return rest(walk, part);
    }
    if (target === undefined) walk.done.push(part);
    else if (!follow(walk, target)) return lexical(path);
  }
  return `/${walk.done.join('/')}`;
}
