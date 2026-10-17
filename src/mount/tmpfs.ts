import { ChunkedBytes } from './chunked.ts';
import { type FilesystemHandlers, fsError, type OpenFlags } from './driver.ts';
import type { DriverAttr, DriverEntry, DriverOwner } from './protocol.ts';

interface Node {
  kind: DriverAttr['kind'];
  ino: number;
  mode: number;
  mtime: number;
  atime: number;
  data: ChunkedBytes;
  target: string;
  children: Map<string, Node>;
  links: number;
  uid: number;
  gid: number;
}

function idOption(value: string | undefined): number {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : 0;
}

function created(
  ino: number,
  kind: Node['kind'],
  mode: number,
  from?: Node,
  owner?: DriverOwner
): Node {
  const now = Date.now();
  return {
    kind,
    ino,
    mode: owner?.mode === undefined ? mode : (mode & ~0o7777) | (owner.mode & 0o7777),
    mtime: now,
    atime: now,
    data: new ChunkedBytes(),
    target: '',
    children: new Map(),
    links: 1,
    uid: owner?.uid ?? from?.uid ?? 0,
    gid: owner?.gid ?? from?.gid ?? 0,
  };
}

function owned(node: Node, change: { uid?: number; gid?: number }): void {
  if (change.uid !== undefined) node.uid = change.uid;
  if (change.gid !== undefined) node.gid = change.gid;
}

function attr(node: Node): DriverAttr {
  return {
    kind: node.kind,
    size:
      node.kind === 'file'
        ? node.data.size
        : node.kind === 'symlink'
          ? node.target.length
          : node.kind === 'fifo'
            ? 0
            : 4096,
    mtime: node.mtime,
    atime: node.atime,
    mode: node.mode,
    ino: node.ino,
    ...(node.kind === 'directory' ? {} : { nlink: node.links }),
    uid: node.uid,
    gid: node.gid,
  };
}

interface Handle {
  node: Node;
  write: boolean;
}

export function tmpfs(): FilesystemHandlers {
  let inodes = 0;
  const make = (kind: Node['kind'], mode: number, from?: Node, owner?: DriverOwner): Node =>
    created(++inodes, kind, mode, from, owner);
  const root = make('directory', 0o40755);
  const handles = new Map<number, Handle>();
  let nextFh = 0;

  const parts = (path: string) => path.split('/').filter(Boolean);
  const place = (dir: Node, name: string, node: Node): void => {
    dir.children.set(name, node);
    dir.mtime = Date.now();
  };
  function find(path: string): Node {
    let node = root;
    for (const name of parts(path)) {
      if (node.kind !== 'directory') throw fsError('ENOTDIR', path);
      const next = node.children.get(name);
      if (!next) throw fsError('ENOENT', path);
      node = next;
    }
    return node;
  }
  function parent(path: string): { dir: Node; name: string } {
    const names = parts(path);
    const name = names.pop();
    if (name === undefined) throw fsError('EBUSY', 'the root of a mount');
    const dir = find(`/${names.join('/')}`);
    if (dir.kind !== 'directory') throw fsError('ENOTDIR', path);
    return { dir, name };
  }
  const handle = (fh: number): Handle => {
    const found = handles.get(fh);
    if (!found) throw fsError('EBADF', `handle ${fh}`);
    return found;
  };
  function opened(path: string, flags: OpenFlags): Node {
    const { dir, name } = parent(path);
    const existing = dir.children.get(name);
    if (existing && flags.exclusive) throw fsError('EEXIST', path);
    if (existing?.kind === 'directory' && flags.write) throw fsError('EISDIR', path);
    if (existing?.kind === 'fifo') throw fsError('ENXIO', path);
    if (existing) return existing;
    if (!flags.create) throw fsError('ENOENT', path);
    const node = make('file', 0o100644, dir, flags.owner);
    place(dir, name, node);
    return node;
  }

  return {
    mount(info) {
      root.uid = idOption(info.options.uid);
      root.gid = idOption(info.options.gid);
      return undefined;
    },
    async getattr(path) {
      return attr(find(path));
    },
    async readdir(path) {
      const dir = find(path);
      if (dir.kind !== 'directory') throw fsError('ENOTDIR', path);
      return [...dir.children].map(
        ([name, node]): DriverEntry => ({ name, kind: node.kind, attr: attr(node) })
      );
    },
    async open(path, flags) {
      const node = opened(path, flags);
      if (flags.truncate && node.kind === 'file') {
        node.data.truncate(0);
        node.mtime = Date.now();
      }
      handles.set(++nextFh, { node, write: flags.write });
      return nextFh;
    },
    async read(fh, offset, size) {
      return handle(fh).node.data.read(offset, size);
    },
    async write(fh, offset, bytes) {
      const h = handle(fh);
      if (!h.write) throw fsError('EBADF', `handle ${fh} is read-only`);
      h.node.data.write(offset, bytes, true);
      h.node.mtime = Date.now();
    },
    async release(fh) {
      handle(fh);
      handles.delete(fh);
    },
    async mkfifo(path, owner) {
      const { dir, name } = parent(path);
      if (dir.children.has(name)) throw fsError('EEXIST', path);
      place(dir, name, make('fifo', 0o10644, dir, owner));
    },
    async mkdir(path, owner) {
      const { dir, name } = parent(path);
      if (dir.children.has(name)) throw fsError('EEXIST', path);
      place(dir, name, make('directory', 0o40755, dir, owner));
    },
    async rmdir(path) {
      const { dir, name } = parent(path);
      const node = dir.children.get(name);
      if (!node) throw fsError('ENOENT', path);
      if (node.kind !== 'directory') throw fsError('ENOTDIR', path);
      if (node.children.size > 0) throw fsError('ENOTEMPTY', path);
      dir.children.delete(name);
      dir.mtime = Date.now();
    },
    async unlink(path) {
      const { dir, name } = parent(path);
      const node = dir.children.get(name);
      if (!node) throw fsError('ENOENT', path);
      if (node.kind === 'directory') throw fsError('EISDIR', path);
      dir.children.delete(name);
      node.links--;
      dir.mtime = Date.now();
    },
    async rename(from, to) {
      const a = `/${parts(from).join('/')}`;
      const b = `/${parts(to).join('/')}`;
      if (b !== a && b.startsWith(`${a}/`)) throw fsError('EINVAL', `${to} is inside ${from}`);
      const source = parent(from);
      const node = source.dir.children.get(source.name);
      if (!node) throw fsError('ENOENT', from);
      const target = parent(to);
      const replaced = target.dir.children.get(target.name);
      if (replaced === node) return;
      if (
        replaced?.kind === 'directory' &&
        (node.kind !== 'directory' || replaced.children.size > 0)
      ) {
        throw fsError(node.kind === 'directory' ? 'ENOTEMPTY' : 'EISDIR', to);
      }
      source.dir.children.delete(source.name);
      if (replaced) replaced.links--;
      target.dir.children.set(target.name, node);
      source.dir.mtime = Date.now();
      target.dir.mtime = source.dir.mtime;
    },
    async link(from, to) {
      const node = find(from);
      if (node.kind === 'directory') throw fsError('EPERM', `${from} is a directory`);
      const { dir, name } = parent(to);
      if (dir.children.has(name)) throw fsError('EEXIST', to);
      place(dir, name, node);
      node.links++;
    },
    async symlink(target, path, owner) {
      const { dir, name } = parent(path);
      if (dir.children.has(name)) throw fsError('EEXIST', path);
      const node = make('symlink', 0o120777, dir, owner && { ...owner, mode: 0o777 });
      node.target = target;
      place(dir, name, node);
    },
    async readlink(path) {
      const node = find(path);
      if (node.kind !== 'symlink') throw fsError('EINVAL', path);
      return node.target;
    },
    async setattr(path, change) {
      const node = find(path);
      if (change.mode !== undefined) node.mode = (node.mode & ~0o7777) | (change.mode & 0o7777);
      if (change.size !== undefined) {
        if (node.kind !== 'file')
          throw fsError(node.kind === 'directory' ? 'EISDIR' : 'EINVAL', path);
        node.data.truncate(change.size);
        node.mtime = Date.now();
      }
      if (change.mtime !== undefined) node.mtime = change.mtime;
      if (change.atime !== undefined) node.atime = change.atime;
      owned(node, change);
    },
    async statfs() {
      return { bsize: 4096, blocks: 262144, bfree: 262144 };
    },
  };
}
