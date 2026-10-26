export const REPLACING_LOCK = 'slicc-kernel-replacing:v1:';
export const REPLACED_WAIT_MS = 150;

export interface ReplacingLocks {
  request(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean },
    callback: (lock: unknown) => unknown
  ): Promise<unknown>;
}

export function replacingLocks(scope: object = globalThis): ReplacingLocks | undefined {
  const locks = (scope as { navigator?: { locks?: ReplacingLocks } }).navigator?.locks;
  return typeof locks?.request === 'function' ? locks : undefined;
}

export function replacingLock(metadata: string, root: string): string {
  return `${REPLACING_LOCK}${metadata}:${root}`;
}

export function exclusively<T>(
  locks: ReplacingLocks,
  names: readonly string[],
  run: () => Promise<T>
): Promise<T> {
  const [name, ...rest] = names;
  if (name === undefined) return run();
  return locks.request(name, { mode: 'exclusive' }, () =>
    exclusively(locks, rest, run)
  ) as Promise<T>;
}

function shared<T>(
  locks: ReplacingLocks,
  names: readonly string[],
  run: (waited: boolean) => Promise<T>,
  waited: boolean
): Promise<T> {
  const [name, ...rest] = names;
  if (name === undefined) return run(waited);
  const next = (after: boolean) => shared(locks, rest, run, after);
  return locks.request(name, { mode: 'shared', ifAvailable: true }, (lock) =>
    lock ? next(waited) : locks.request(name, { mode: 'shared' }, () => next(true))
  ) as Promise<T>;
}

export class PackageLocks {
  private readonly locks: ReplacingLocks | undefined;
  private readonly metadata: string;

  constructor(metadata: string, locks = replacingLocks()) {
    this.metadata = metadata;
    this.locks = locks;
  }

  loading<T>(roots: readonly string[], run: (waited: boolean) => Promise<T>): Promise<T> {
    if (!this.locks || roots.length === 0) return run(false);
    const names = roots.map((root) => replacingLock(this.metadata, root));
    return shared(this.locks, names, run, false);
  }
}
