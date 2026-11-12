export type HeaderWatcher = (index: number, bits: number) => void;

const watchers = new WeakMap<ArrayBufferLike, HeaderWatcher>();
let watching = 0;

export function watchHeader(sab: SharedArrayBuffer, watcher: HeaderWatcher): () => void {
  if (!watchers.has(sab)) watching++;
  watchers.set(sab, watcher);
  return () => {
    if (watchers.get(sab) !== watcher) return;
    watchers.delete(sab);
    watching--;
  };
}

export function headerNotified(header: Int32Array, index: number, bits = 0): void {
  if (watching === 0) return;
  watchers.get(header.buffer)?.(index, bits);
}
