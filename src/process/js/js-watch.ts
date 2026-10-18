import type { WatchNote } from '../../fs/watch.ts';
import type { JsKernel } from './js-kernel.ts';

export type JsWatchNote = WatchNote;

export interface JsWatchOptions {
  recursive?: boolean;
}

export interface JsWatcher {
  close(): void;
}

export type JsWatchListener = (note: JsWatchNote) => void;

export function watchRequest(path: string, options: JsWatchOptions | undefined) {
  return { op: 'watch-open' as const, path, ...(options?.recursive ? { recursive: true } : {}) };
}

export function watchArgs(
  options: JsWatchOptions | JsWatchListener | undefined,
  listener: JsWatchListener | undefined
): [JsWatchOptions, JsWatchListener] {
  const onNote = typeof options === 'function' ? options : listener;
  if (typeof onNote !== 'function') throw new TypeError('watch needs a listener');
  return [typeof options === 'object' && options !== null ? options : {}, onNote];
}

export function follow(
  kernel: Pick<JsKernel, 'blocking' | 'call'>,
  id: number,
  onNote: JsWatchListener
): JsWatcher {
  const stop = new AbortController();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stop.abort();
    kernel.call({ op: 'watch-close', id }).catch(() => undefined);
  };
  const pump = async () => {
    while (!closed) {
      let notes: JsWatchNote[];
      try {
        const r = await kernel.blocking({ op: 'watch-next', id }, stop.signal);
        notes = r.ok && r.kind === 'json' ? (r.json as JsWatchNote[]) : [];
      } catch {
        closed = true;
        return;
      }
      for (const note of notes) {
        if (closed) return;
        if ('ended' in note) closed = true;
        onNote(note);
      }
    }
  };
  void pump();
  return { close };
}
