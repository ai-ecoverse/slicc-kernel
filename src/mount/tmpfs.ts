import { type FilesystemHandlers, fsError, type OpenFlags } from './driver.ts';
import type { DriverAttr, DriverEntry } from './protocol.ts';

interface Node {
  kind: DriverAttr['kind'];
  ino: number;
  mode: number;
  mtime: number;
  data: Uint8Array;
  target: string;
  children: Map<string, Node>;
}

interface Handle {
  node: Node;
  data: Uint8Array;
  length: number;
  dirty: boolean;
}

export function tmpfs(): FilesystemHandlers {
  let inodes = 0;
  const make = (kind: Node['kind'], mode: number): Node => ({
    kind,
    ino: ++inodes,
    mode,
    mtime: Date.now(),
    data: new Uint8Array(0),
    target: '',
    children: new Map(),
  });
  const root = make('directory', 0o40755);
  const handles = new Map<number, Handle>();
  let nextFh = 0;

  const parts = (path: string) => path.split('/').filter(Boolean);
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
  const attr = (node: Node): DriverAttr => ({
    kind: node.kind,
    size:
      node.kind === 'file' ? node.data.length : node.kind === 'symlink' ? node.target.length : 4096,
    mtime: node.mtime,
    mode: node.mode,
    ino: node.ino,
  });
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
    if (existing) return existing;
    if (!flags.create) throw fsError('ENOENT', path);
    const node = make('file', 0o100644);
    dir.children.set(name, node);
    dir.mtime = Date.now();
    return node;
  }

  return {
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
      const data = flags.truncate ? new Uint8Array(0) : node.data.slice();
      handles.set(++nextFh, { node, data, length: data.length, dirty: flags.truncate });
      return nextFh;
    },
    async read(fh, offset, size) {
      const h = handle(fh);
      return h.data.slice(offset, Math.min(h.length, offset + size));
    },
    async write(fh, offset, bytes) {
      const h = handle(fh);
      const end = offset + bytes.length;
      if (end > h.data.length) {
        const grown = new Uint8Array(Math.max(end, h.data.length * 2));
        grown.set(h.data.subarray(0, h.length));
        h.data = grown;
      }
      h.data.set(bytes, offset);
      h.length = Math.max(h.length, end);
      h.dirty = true;
    },
    async release(fh) {
      const h = handle(fh);
      handles.delete(fh);
      if (!h.dirty) return;
      h.node.data = h.data.slice(0, h.length);
      h.node.mtime = Date.now();
    },
    async mkdir(path) {
      const { dir, name } = parent(path);
      if (dir.children.has(name)) throw fsError('EEXIST', path);
      dir.children.set(name, make('directory', 0o40755));
    },
    async rmdir(path) {
      const { dir, name } = parent(path);
      const node = dir.children.get(name);
      if (!node) throw fsError('ENOENT', path);
      if (node.kind !== 'directory') throw fsError('ENOTDIR', path);
      if (node.children.size > 0) throw fsError('ENOTEMPTY', path);
      dir.children.delete(name);
    },
    async unlink(path) {
      const { dir, name } = parent(path);
      const node = dir.children.get(name);
      if (!node) throw fsError('ENOENT', path);
      if (node.kind === 'directory') throw fsError('EISDIR', path);
      dir.children.delete(name);
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
      target.dir.children.set(target.name, node);
    },
    async symlink(target, path) {
      const { dir, name } = parent(path);
      if (dir.children.has(name)) throw fsError('EEXIST', path);
      const node = make('symlink', 0o120777);
      node.target = target;
      dir.children.set(name, node);
    },
    async readlink(path) {
      const node = find(path);
      if (node.kind !== 'symlink') throw fsError('EINVAL', path);
      return node.target;
    },
    async setattr(path, change) {
      const node = find(path);
      if (change.mode !== undefined) node.mode = (node.mode & ~0o7777) | (change.mode & 0o7777);
      if (change.mtime !== undefined) node.mtime = change.mtime;
    },
    async statfs() {
      return { bsize: 4096, blocks: 262144, bfree: 262144 };
    },
  };
}
