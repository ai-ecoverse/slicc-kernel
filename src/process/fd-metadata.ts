import type { ProcessFs, ProcessStream, ProcessSys } from './kernel-streams.ts';
import { fdOfPath } from './process-fds.ts';

type Call = <T>(syscall: () => T) => T;

interface MetadataFs {
  chown?(path: string | object, uid: number, gid: number, dontFollow?: boolean): void;
  lchown?(path: string, uid: number, gid: number): void;
  fchown?(fd: number, uid: number, gid: number): void;
  chmod?(path: string | object, mode: number, dontFollow?: boolean): void;
  fchmod?(fd: number, mode: number): void;
  utime?(path: string, atime: number | null, mtime: number | null): void;
  sliccTouch?: boolean;
}

function idOf(value: number): number | undefined {
  return value === -1 || value === 0xffffffff ? undefined : value >>> 0;
}

function timeOf(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function useKernelFdMetadata(Fs: ProcessFs, sys: ProcessSys, call: Call): void {
  const { fdChown, fdChmod, fdUtimes } = sys;
  const meta = Fs as unknown as MetadataFs;
  const kernelFd = (stream: ProcessStream | null | undefined): number | undefined =>
    stream?.sliccKernelFile ? stream.sliccKernelFd : undefined;
  const find = (match: (s: ProcessStream) => boolean): number | undefined => {
    for (const s of Fs.streams) {
      const kfd = s && match(s) ? kernelFd(s) : undefined;
      if (kfd !== undefined) return kfd;
    }
    return undefined;
  };
  const ofPath = (path: string | object, follow: boolean): number | undefined => {
    if (typeof path !== 'string') return find((s) => s.node === path);
    const fd = follow ? fdOfPath(path, Fs.cwd()) : undefined;
    if (fd !== undefined) return kernelFd(Fs.getStream(fd));
    return find((s) => s.path === path);
  };
  const ofFd = (fd: number): number | undefined => kernelFd(Fs.getStream(fd));
  const chownBy = (kfd: number, uid: number, gid: number) =>
    call(() => fdChown?.call(sys, kfd, idOf(uid), idOf(gid)));
  if (fdChown && meta.chown) {
    const chown = meta.chown.bind(Fs);
    meta.chown = (path, uid, gid, dontFollow) => {
      const kfd = ofPath(path, !dontFollow);
      if (kfd === undefined) return chown(path, uid, gid, dontFollow);
      chownBy(kfd, uid, gid);
    };
  }
  if (fdChown && meta.fchown) {
    const fchown = meta.fchown.bind(Fs);
    meta.fchown = (fd, uid, gid) => {
      const kfd = ofFd(fd);
      if (kfd === undefined) return fchown(fd, uid, gid);
      chownBy(kfd, uid, gid);
    };
  }
  if (fdChmod && meta.chmod) {
    const chmod = meta.chmod.bind(Fs);
    meta.chmod = (path, mode, dontFollow) => {
      const kfd = ofPath(path, !dontFollow);
      if (kfd === undefined) return chmod(path, mode, dontFollow);
      call(() => fdChmod.call(sys, kfd, mode & 0o7777));
    };
  }
  if (fdChmod && meta.fchmod) {
    const fchmod = meta.fchmod.bind(Fs);
    meta.fchmod = (fd, mode) => {
      const kfd = ofFd(fd);
      if (kfd === undefined) return fchmod(fd, mode);
      call(() => fdChmod.call(sys, kfd, mode & 0o7777));
    };
  }
  if (fdUtimes && meta.utime) {
    const utime = meta.utime.bind(Fs);
    meta.utime = (path, atime, mtime) => {
      const kfd = ofPath(path, true);
      if (kfd === undefined) return utime(path, atime, mtime);
      const now = meta.sliccTouch === true;
      call(() => fdUtimes.call(sys, kfd, timeOf(atime), timeOf(mtime), now));
    };
  }
}
