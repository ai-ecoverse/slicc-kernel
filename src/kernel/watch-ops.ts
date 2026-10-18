import type { TypedWatch } from '../fs/watch.ts';
import type { SyncFsResult } from '../realm/sync-fs-wire.ts';
import { KernelError } from './fd-table.ts';

export type WatchSyscall =
  | { op: 'watch-open'; path: string; recursive?: boolean }
  | { op: 'watch-next'; id: number }
  | { op: 'watch-close'; id: number };

export const WATCH_OPS = ['watch-open', 'watch-next', 'watch-close'] as const;

const WATCHING: ReadonlySet<string> = new Set(WATCH_OPS);

export function isWatchSyscall(req: { op: string }): req is WatchSyscall {
  return WATCHING.has(req.op);
}

export interface WatchSource {
  open(path: string, recursive: boolean): Promise<TypedWatch>;
}

export class ProcessWatches {
  private readonly open = new Map<number, TypedWatch>();
  private nextId = 1;
  private readonly source: WatchSource | undefined;

  constructor(source: WatchSource | undefined) {
    this.source = source;
  }

  async syscall(req: WatchSyscall, cancelled: AbortSignal): Promise<SyncFsResult> {
    if (req.op === 'watch-open') {
      if (!this.source) throw new KernelError('ENOSYS');
      const watch = await this.source.open(req.path, req.recursive === true);
      const id = this.nextId++;
      this.open.set(id, watch);
      return { ok: true, kind: 'json', json: id };
    }
    const watch = this.open.get(req.id);
    if (req.op === 'watch-close') {
      watch?.close();
      this.open.delete(req.id);
      return { ok: true, kind: 'void' };
    }
    if (!watch) return { ok: true, kind: 'json', json: [{ ended: true }] };
    const notes = await watch.next(cancelled);
    if (notes.some((note) => 'ended' in note)) this.open.delete(req.id);
    return { ok: true, kind: 'json', json: notes };
  }

  closeAll(): void {
    for (const watch of this.open.values()) watch.close();
    this.open.clear();
  }
}
