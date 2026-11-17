import type { DeviceNodeInfo } from '../kernel/devices.ts';
import { SysTree } from '../kernel/sysfs.ts';
import type { SyncFsBridgeStat } from '../realm/sync-fs-wire.ts';
import { wasiErrno } from './wasi-errno.ts';

interface SysNode {
  mode: number;
  node_ops: {
    lookup?: (parent: SysNode, name: string) => SysNode;
    readdir?: (node: SysNode) => string[];
    getattr?: (node: SysNode) => object;
    setattr?: (node: SysNode, attr: object) => void;
    readlink?: (node: SysNode) => string;
    rename?: () => never;
  };
  stream_ops?: object;
}

interface SysStream {
  position: number;
  sliccSys?: Uint8Array;
}

export interface SysFs {
  mkdir?(path: string, mode?: number): unknown;
  createNode?(parent: object, name: string, mode: number, rdev: number): object;
  hashRemoveNode?(node: object): void;
  ErrnoError: new (errno: number) => Error;
}

export interface SysSource {
  devNodes?(): DeviceNodeInfo[];
}

function attr(st: SyncFsBridgeStat): object {
  return {
    dev: 5,
    ino: st.ino,
    mode: st.mode,
    nlink: st.nlink,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: st.size,
    atime: new Date(st.atimeMs as number),
    mtime: new Date(st.mtimeMs as number),
    ctime: new Date(st.ctimeMs as number),
    blksize: 4096,
    blocks: 0,
  };
}

export function useSysfs(Fs: SysFs, sys: SysSource): void {
  const { mkdir, createNode, hashRemoveNode } = Fs;
  const devNodes = sys.devNodes?.bind(sys);
  if (!mkdir || !createNode || !hashRemoveNode || !devNodes) return;
  let top: SysNode;
  try {
    top = mkdir.call(Fs, '/sys', 0o755) as SysNode;
  } catch {
    return;
  }
  const error = (code: string) => new Fs.ErrnoError(wasiErrno(code));
  const ask = <T>(work: (tree: SysTree) => T): T => {
    try {
      return work(new SysTree(() => devNodes() ?? []));
    } catch (err) {
      throw error((err as { code?: string }).code ?? 'EIO');
    }
  };
  const readOnly = () => {
    throw error('EROFS');
  };
  const seek = (stream: SysStream, offset: number, whence: number, end: number) => {
    const at = (whence === 1 ? stream.position : whence === 2 ? end : 0) + offset;
    if (at < 0) throw error('EINVAL');
    return at;
  };
  const dirOps = (path: string, st: SyncFsBridgeStat): SysNode['node_ops'] => ({
    getattr: () => attr(st),
    setattr: readOnly,
    rename: readOnly,
    lookup: (parent, name) => make(parent, name, `${path}/${name}`),
    readdir: () => ['.', '..', ...ask((tree) => tree.readdir(path))],
  });
  const make = (parent: SysNode, name: string, path: string): SysNode => {
    const { st, target } = ask((tree) => {
      const st = tree.stat(path, false);
      return { st, target: st.isSymbolicLink ? tree.readlink(path) : undefined };
    });
    const node = createNode.call(Fs, parent, name, st.mode as number, 0) as SysNode;
    hashRemoveNode.call(Fs, node);
    if (st.isDirectory) {
      node.node_ops = dirOps(path, st);
      node.stream_ops = { llseek: (s: SysStream, o: number, w: number) => seek(s, o, w, 0) };
    } else if (target !== undefined) {
      node.node_ops = { getattr: () => attr(st), setattr: readOnly, readlink: () => target };
    } else {
      node.node_ops = { getattr: () => attr(st), setattr: readOnly };
      node.stream_ops = {
        open: (stream: SysStream) => {
          stream.sliccSys = ask((tree) => tree.read(path));
        },
        read: (
          stream: SysStream,
          buffer: Uint8Array,
          offset: number,
          length: number,
          at: number
        ) => {
          const chunk = (stream.sliccSys ?? new Uint8Array(0)).subarray(at, at + length);
          buffer.set(chunk, offset);
          return chunk.length;
        },
        write: readOnly,
        llseek: (s: SysStream, o: number, w: number) => seek(s, o, w, s.sliccSys?.length ?? 0),
      };
    }
    return node;
  };
  top.node_ops = dirOps('/sys', new SysTree(() => []).stat('/sys'));
}
