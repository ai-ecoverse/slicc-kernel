import type { RemoteChange } from './remote.ts';
import { type FsStat, type KernelFs, normalizePath, type UsersMode } from './types.ts';
import type { FsWatchers } from './watch.ts';

export const ATTEST_MAX = 1024 * 1024;

const UNOWNED = 1000;

export interface AttestedDir {
  path: string;
  uid: number;
  gid: number;
  mode: number;
}

export interface Attestation {
  path: string;
  bytes: Uint8Array;
  uid: number;
  gid: number;
  mode: number;
  ino: number;
  mtimeMs: number;
  sha256: string;
  users: UsersMode;
  onRootFs: boolean;
  parents: AttestedDir[];
}

export interface AttestContext {
  users: UsersMode;
  mounts: readonly string[];
}

function refuse(code: string, path: string, why: string): never {
  throw Object.assign(new Error(`attest ${path}: ${why}`), { code });
}

function chainOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return ['/', ...parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)];
}

function under(path: string, target: string): boolean {
  return path === target || path.startsWith(`${target}/`);
}

function owned(path: string, st: FsStat): AttestedDir {
  return { path, uid: st.uid ?? UNOWNED, gid: st.gid ?? UNOWNED, mode: st.mode };
}

function unchanged(a: FsStat, b: FsStat, bytes: Uint8Array): boolean {
  return (
    a.ino === b.ino &&
    a.mtime.getTime() === b.mtime.getTime() &&
    a.size === b.size &&
    bytes.length === b.size
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function attested(
  path: string,
  st: FsStat,
  bytes: Uint8Array,
  digest: string,
  o: AttestContext,
  parents: AttestedDir[]
): Attestation {
  const { uid, gid, mode } = owned(path, st);
  return {
    path,
    bytes,
    uid,
    gid,
    mode,
    ino: st.ino,
    mtimeMs: st.mtime.getTime(),
    sha256: digest,
    users: o.users,
    onRootFs: true,
    parents,
  };
}

async function trustedParents(
  fs: KernelFs,
  path: string,
  o: AttestContext
): Promise<AttestedDir[]> {
  const parents: AttestedDir[] = [];
  for (const dir of chainOf(path).slice(0, -1)) {
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink) refuse('EACCES', path, `${dir} is a symlink`);
    if (!st.isDirectory) refuse('ENOTDIR', path, `${dir} is not a directory`);
    const perm = owned(dir, st);
    if (o.users !== 'off' && (perm.uid !== 0 || (perm.mode & 0o022) !== 0)) {
      refuse('EACCES', path, `${dir} is not root-owned or is writable by group or others`);
    }
    parents.push(perm);
  }
  return parents;
}

export async function attest(fs: KernelFs, asked: string, o: AttestContext): Promise<Attestation> {
  if (typeof asked !== 'string' || !asked.startsWith('/')) {
    refuse('EINVAL', String(asked), 'not an absolute path');
  }
  const path = normalizePath(asked);
  const mount = o.mounts.find((target) => target !== '/' && under(path, normalizePath(target)));
  if (mount !== undefined) refuse('EACCES', path, `under the mount ${mount}`);
  const parents = await trustedParents(fs, path, o);
  for (let tries = 0; ; tries++) {
    const before = await fs.lstat(path);
    if (before.isSymbolicLink) refuse('EACCES', path, 'is a symlink');
    if (!before.isFile)
      refuse(before.isDirectory ? 'EISDIR' : 'EINVAL', path, 'is not a regular file');
    if (before.size > ATTEST_MAX) refuse('EFBIG', path, `is over ${ATTEST_MAX} bytes`);
    const bytes = (await fs.readFileBuffer(path)).slice();
    const after = await fs.lstat(path);
    if (unchanged(before, after, bytes)) {
      return attested(path, after, bytes, await sha256(bytes), o, parents);
    }
    if (tries >= 1) refuse('EAGAIN', path, 'changed while it was read');
  }
}

export const WATCH_DEBOUNCE_MS = 50;

export interface RemoteFs {
  remoteChanges?(listener: (change: RemoteChange) => void): () => void;
  announceWatch?(paths: readonly string[]): Promise<void>;
}

export class FileWatches {
  private readonly live = new Set<readonly string[]>();
  private readonly local: FsWatchers;
  private readonly remote: RemoteFs;

  constructor(local: FsWatchers, remote: RemoteFs) {
    this.local = local;
    this.remote = remote;
  }

  private announce(): Promise<void> {
    return this.remote.announceWatch?.([...new Set([...this.live].flat())]) ?? Promise.resolve();
  }

  async watch(paths: readonly string[], notify: (path: string) => void): Promise<() => void> {
    const files = paths.map(normalizePath);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let active = true;
    const fire = (changed: readonly string[], trees: readonly string[]) => {
      for (const file of files) {
        const hit = [...changed, ...trees].some((p) => under(file, normalizePath(p)));
        if (!hit) continue;
        clearTimeout(timers.get(file));
        timers.set(
          file,
          setTimeout(() => {
            timers.delete(file);
            if (active) notify(file);
          }, WATCH_DEBOUNCE_MS)
        );
      }
    };
    const unwatch = this.local.watch(files, { recursive: false }, (change) =>
      fire('overflow' in change ? files : change.paths, [])
    );
    const unlisten = this.remote.remoteChanges?.((change) => fire(change.paths, change.trees));
    this.live.add(files);
    await this.announce();
    return () => {
      if (!active) return;
      active = false;
      for (const timer of timers.values()) clearTimeout(timer);
      unwatch();
      unlisten?.();
      this.live.delete(files);
      void this.announce();
    };
  }
}
