export type Portable<T extends FileSystemHandle> = { handle: T } | { path: string[] };

type Top = () => Promise<FileSystemDirectoryHandle>;

const privateTop: Top = () => navigator.storage.getDirectory();

export function clonable(handle: FileSystemHandle): boolean {
  const { port1, port2 } = new MessageChannel();
  try {
    port1.postMessage(handle);
    return true;
  } catch (err) {
    if ((err as { name?: unknown } | null)?.name === 'DataCloneError') return false;
    throw err;
  } finally {
    port1.close();
    port2.close();
  }
}

export async function portable<T extends FileSystemHandle>(
  handle: T,
  top: Top = privateTop
): Promise<Portable<T>> {
  if (clonable(handle)) return { handle };
  const path = await (await top()).resolve(handle);
  if (path === null) {
    throw new Error(
      'this browser cannot hand a folder to a worker unless it is in the origin private file system'
    );
  }
  return { path };
}

export async function directoryAt(
  top: FileSystemDirectoryHandle,
  path: readonly string[]
): Promise<FileSystemDirectoryHandle> {
  let dir = top;
  for (const name of path) dir = await dir.getDirectoryHandle(name);
  return dir;
}

export const samePath = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((name, at) => name === b[at]);
